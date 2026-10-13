import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Config } from './config.js';
import { SchoolFoxError, idSchema, list, object, requiredId, quoteId, type RecordData } from './contracts.js';
import { confirmationBody, replyBody, type Identity } from './writes.js';

const BASE = 'https://api.schoolfox.com/';
type Fetch = typeof fetch;
export class SchoolFoxClient {
  private token?: string;
  private identity?: Identity;
  private loginAttempted = false;
  private loginPromise?: Promise<void>;
  constructor(private config: Config, private fetcher: Fetch = fetch, private now: () => Date = () => new Date()) {
    this.token = config.token;
  }
  status() { return { configured: Boolean(this.token || (this.config.email && this.config.password)), mode: this.config.email ? 'login' : this.token ? 'token' : 'none', writeReady: Boolean(this.identity), detailGetReadState: 'unverified' }; }
  private async auth(operation: string): Promise<void> {
    if (this.token) return;
    if (!this.config.email || !this.config.password) throw new SchoolFoxError(operation, 'credentials_required');
    if (this.loginPromise) return this.loginPromise;
    if (this.loginAttempted) throw new SchoolFoxError(operation, 'authentication_required');
    this.loginAttempted = true;
    this.loginPromise = this.login();
    return this.loginPromise;
  }
  private async login(): Promise<void> {
    const result = object(await this.request('login', 'POST', 'api/Users/login', { username: this.config.email, password: this.config.password, applicationType: 'SchoolFox' }, false), 'login');
    const user = object(result.user, 'login');
    if (user.twoFactorAuthActive === true || user.twoFactorAuthStatus === 'Required') throw new SchoolFoxError('login', 'two_factor_unsupported');
    if (user.twoFactorAuthActive !== false || !['Optional', 'Disabled'].includes(String(user.twoFactorAuthStatus))) throw new SchoolFoxError('login', 'two_factor_state_unverified');
    if (typeof result.token !== 'string' || !result.token) throw new SchoolFoxError('login', 'authentication_required');
    const userId = requiredId(user.id, 'login');
    const fullUsername = typeof user.firstName === 'string' && user.firstName.trim() && typeof user.lastName === 'string' && user.lastName.trim()
      ? `${user.firstName.trim()} ${user.lastName.trim()}`
      : typeof user.fullUsername === 'string' && user.fullUsername.trim()
        ? user.fullUsername.trim()
        : undefined;
    this.identity = fullUsername ? { id: userId, fullUsername } : undefined;
    this.token = result.token;
  }
  private async readBytes(response: Response, limit: number, operation: string): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length && Number(length) > limit) {
      await response.body?.cancel().catch(() => {});
      throw new SchoolFoxError(operation, 'response_too_large');
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > limit) throw new SchoolFoxError(operation, 'response_too_large');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return bytes;
  }
  private async request(operation: string, method: 'GET'|'POST'|'PATCH', path: string, body?: RecordData, authenticate = true, binary = false): Promise<unknown> {
    if (authenticate) await this.auth(operation);
    const url = new URL(path, BASE);
    if (url.origin !== 'https://api.schoolfox.com' || !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tables/')) throw new SchoolFoxError(operation, 'unsafe_path');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string,string> = { 'ZUMO-API-VERSION': '2.0.0' };
      if (this.token && authenticate) headers['X-ZUMO-AUTH'] = this.token;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await this.fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new SchoolFoxError(operation, 'redirect_rejected', response.status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) this.identity = undefined;
        throw new SchoolFoxError(operation, response.status === 401 ? 'authentication_required' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'http_error', response.status);
      }
      const bytes = await this.readBytes(response, binary ? this.config.maxDownloadBytes : this.config.maxResponseBytes, operation);
      if (binary) return bytes;
      if (!bytes.length) return {};
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new SchoolFoxError(operation, 'invalid_json'); }
    } catch (error) {
      if (error instanceof SchoolFoxError) throw error;
      throw new SchoolFoxError(operation, controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
  private query(path: string, filter: string, order: string, top: number, skip: number): string {
    const url = new URL(path, BASE);
    url.searchParams.set('$filter', filter); url.searchParams.set('$orderby', order);
    url.searchParams.set('$top', String(top)); url.searchParams.set('$skip', String(skip)); url.searchParams.set('$inlinecount', 'allpages');
    return url.pathname.slice(1) + url.search;
  }
  private nativeFileName(name: string): string {
    if (!name || name === '.' || name === '..' || Buffer.byteLength(name, 'utf8') > 255 || /[\\/\x00-\x1f\x7f]/u.test(name)) {
      throw new SchoolFoxError('message_attachment_download', 'unsafe_filename');
    }
    return name;
  }
  private async saveDownload(name: string, bytes: Uint8Array, operation: string) {
    await mkdir(this.config.downloadDir, { recursive: true, mode: 0o700 });
    const target = join(resolve(this.config.downloadDir), name);
    const handle = await open(target, 'wx', 0o600).catch(() => { throw new SchoolFoxError(operation, 'file_exists_or_unwritable'); });
    try {
      await handle.writeFile(bytes);
      await handle.close();
    } catch {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw new SchoolFoxError(operation, 'file_write_failed');
    }
    return { path: target, bytes: bytes.length };
  }
  async inventory(schoolId?: string) {
    const path = schoolId ? `api/Common/Inventory?schoolId=${encodeURIComponent(idSchema.parse(schoolId))}` : 'api/Common/Inventory';
    const data = await this.request('inventory', 'GET', path);
    if (!Array.isArray(data)) throw new SchoolFoxError('inventory', 'unexpected_response');
    return data.map(x => { const row = object(x, 'inventory'); requiredId(row.id, 'inventory'); return row; });
  }
  async messages(classId: string, pupilId: string, top: number, skip: number) {
    const path = this.query('tables/Messages', `Deleted eq false and SchoolClassId eq ${quoteId(classId)} and PupilId eq ${quoteId(pupilId)}`, 'UpdatedAt desc', top, skip);
    return list(await this.request('messages', 'GET', path), 'messages');
  }
  async messageDetail(messageId: string) {
    const data = object(await this.request('message_detail', 'GET', `tables/Messages/${idSchema.parse(messageId)}`), 'message_detail');
    if (requiredId(data.id, 'message_detail') !== messageId) throw new SchoolFoxError('message_detail', 'unexpected_response');
    return data;
  }
  async messageAttachments(messageId: string) {
    const id = idSchema.parse(messageId);
    const data = await this.request('message_attachments', 'GET', `api/Files/Messages/${id}`);
    if (!Array.isArray(data)) throw new SchoolFoxError('message_attachments', 'unexpected_response');
    const attachments = data.map(value => {
      const row = object(value, 'message_attachments');
      if (typeof row.name !== 'string' || !row.name.length || !Number.isSafeInteger(row.size) || (row.size as number) < 0) {
        throw new SchoolFoxError('message_attachments', 'unexpected_response');
      }
      return { name: row.name, size: row.size as number };
    });
    return { messageId: id, attachments };
  }
  async downloadMessageAttachment(messageId: string, attachmentName: string, fileName?: string) {
    const operation = 'message_attachment_download';
    const id = idSchema.parse(messageId);
    this.nativeFileName(attachmentName);
    const localName = this.nativeFileName(fileName ?? attachmentName);
    const metadata = await this.messageAttachments(id);
    const matches = metadata.attachments.filter(item => item.name === attachmentName);
    if (matches.length !== 1) {
      throw new SchoolFoxError(operation, 'attachment_not_unique');
    }
    const selected = matches[0]!;
    if (selected.size > this.config.maxDownloadBytes) throw new SchoolFoxError(operation, 'response_too_large');
    await this.auth(operation);
    const apiUrl = new URL(`api/Files/Messages/${id}`, BASE);
    apiUrl.searchParams.set('fileName', attachmentName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let bytes: Uint8Array;
    let contentType: string | null;
    try {
      const response = await this.fetcher(apiUrl, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'X-ZUMO-AUTH': this.token!, 'ZUMO-API-VERSION': '2.0.0' }
      });
      let fileResponse = response;
      let fromFileHost = false;
      if (response.status === 302) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        let redirectUrl: URL;
        try { redirectUrl = new URL(location ?? ''); }
        catch { throw new SchoolFoxError(operation, 'redirect_rejected'); }
        if (redirectUrl.origin !== 'https://getfile.foxeducation.com' || redirectUrl.username || redirectUrl.password || redirectUrl.port) {
          throw new SchoolFoxError(operation, 'redirect_rejected');
        }
        fileResponse = await this.fetcher(redirectUrl, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          credentials: 'omit', referrerPolicy: 'no-referrer'
        });
        fromFileHost = true;
      }
      if (fileResponse.status >= 300 && fileResponse.status < 400) {
        await fileResponse.body?.cancel().catch(() => {});
        throw new SchoolFoxError(operation, 'redirect_rejected', fileResponse.status);
      }
      if (!fileResponse.ok) {
        await fileResponse.body?.cancel().catch(() => {});
        if (fileResponse.status === 401 && !fromFileHost) this.identity = undefined;
        throw new SchoolFoxError(operation, fileResponse.status === 401 && !fromFileHost ? 'authentication_required' : fileResponse.status === 403 ? 'forbidden' : fileResponse.status === 429 ? 'rate_limited' : 'http_error', fileResponse.status);
      }
      if (fileResponse.status !== 200) {
        await fileResponse.body?.cancel().catch(() => {});
        throw new SchoolFoxError(operation, 'unexpected_response', fileResponse.status);
      }
      contentType = fileResponse.headers.get('content-type');
      bytes = await this.readBytes(fileResponse, this.config.maxDownloadBytes, operation);
      if (bytes.length !== selected.size) throw new SchoolFoxError(operation, 'attachment_size_mismatch');
    } catch (error) {
      if (error instanceof SchoolFoxError) throw error;
      throw new SchoolFoxError(operation, controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
    return { ...await this.saveDownload(localName, bytes, operation), contentType };
  }
  async replyGroups(messageId: string, pupilId: string, top: number, skip: number) {
    const path = this.query('tables/InstantMessageGroups', `MessageId eq ${quoteId(messageId)} and PupilId eq ${quoteId(pupilId)}`, 'UpdatedAt desc', top, skip);
    return list(await this.request('reply_groups', 'GET', path), 'reply_groups');
  }
  async replies(groupId: string, pupilId: string, top: number, skip: number) {
    const path = this.query('tables/InstantMessages', `InstantMessageGroupId eq ${quoteId(groupId)} and PupilId eq ${quoteId(pupilId)}`, 'CreatedAt desc', top, skip);
    return list(await this.request('replies', 'GET', path), 'replies');
  }
  async events(classId: string, pupilId: string, top: number, skip: number) {
    const day = this.now().toISOString().slice(0, 10) + 'T00:00:00Z';
    const filter = `Deleted eq false and SchoolClassId eq ${quoteId(classId)} and PupilId eq ${quoteId(pupilId)} and ((MessageType eq 'Event' and EndDate ge datetime'${day}') or DueDate ge datetime'${day}')`;
    return list(await this.request('events', 'GET', this.query('tables/Messages', filter, 'EventDate asc', top, skip)), 'events');
  }
  async files(classId: string, pupilId: string, folderId: string | undefined, top: number, skip: number) {
    const parent = folderId ? quoteId(folderId) : 'null';
    const filter = `SchoolClassId eq ${quoteId(classId)} and ParentItemId eq ${parent} and not (ItemSubType eq 'Portfolio' and Name eq 'Portfolios') and Deleted eq false and (PupilId eq null or PupilId eq ${quoteId(pupilId)})`;
    return list(await this.request('files', 'GET', this.query('tables/FoxDriveItems', filter, 'ItemType, Name', top, skip)), 'files');
  }
  async fileDetail(classId: string, itemId: string) {
    const data = object(await this.request('file_detail', 'GET', `api/FoxDriveItems/${idSchema.parse(classId)}/Item/${idSchema.parse(itemId)}`), 'file_detail');
    if (requiredId(data.id, 'file_detail') !== itemId) throw new SchoolFoxError('file_detail', 'unexpected_response');
    return data;
  }
  async downloadFile(classId: string, itemId: string, fileId: string, fileName: string) {
    const detail = await this.fileDetail(classId, itemId);
    if (detail.schoolClassId !== classId) throw new SchoolFoxError('file_download', 'class_mismatch');
    const safeName = basename(fileName);
    if (safeName !== fileName || safeName === '.' || safeName === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(safeName)) throw new SchoolFoxError('file_download', 'unsafe_filename');
    const files = detail.files;
    if (!Array.isArray(files) || !files.some(x => { const row = object(x, 'file_download'); return row.id === fileId; })) throw new SchoolFoxError('file_download', 'file_mismatch');
    const bytes = await this.request('file_download', 'GET', `api/FoxDriveItems/${idSchema.parse(itemId)}/DownloadFile/${idSchema.parse(fileId)}`, undefined, true, true) as Uint8Array;
    return this.saveDownload(safeName, bytes, 'file_download');
  }
  async reply(messageId: string, pupilId: string, groupId: string, text: string) {
    await this.auth('reply');
    if (!this.identity) throw new SchoolFoxError('reply', 'login_identity_required');
    const detail = await this.messageDetail(messageId);
    if (detail.pupilId !== pupilId) throw new SchoolFoxError('reply', 'pupil_mismatch');
    if (detail.instantMessagesAllowed !== true) throw new SchoolFoxError('reply', detail.instantMessagesAllowed === false ? 'reply_unavailable' : 'reply_permission_unverified');
    if (detail.isOwned === true) {
      if (!Number.isSafeInteger(detail.instantMessagesCount) || (detail.instantMessagesCount as number) < 0) throw new SchoolFoxError('reply', 'reply_permission_unverified');
      if (detail.instantMessagesCount === 0) throw new SchoolFoxError('reply', 'reply_unavailable');
    } else if (detail.isOwned !== false) throw new SchoolFoxError('reply', 'reply_permission_unverified');
    const schoolClassId = requiredId(detail.schoolClassId, 'reply');
    let group: RecordData | undefined;
    for (let skip = 0; skip <= 1000; skip += 50) {
      const groups = await this.replyGroups(messageId, pupilId, 50, skip);
      group = groups.results.find(x => x.id === groupId);
      if (group || groups.results.length === 0 || skip + groups.results.length >= groups.count) break;
    }
    if (!group) throw new SchoolFoxError('reply', 'group_not_found');
    if (group.schoolClassId !== schoolClassId) throw new SchoolFoxError('reply', 'class_mismatch');
    const body = replyBody(group, this.identity, messageId, pupilId, text);
    const response = object(await this.request('reply', 'POST', 'tables/InstantMessages', body), 'reply');
    requiredId(response.id, 'reply');
    return response;
  }
  async confirm(messageId: string, pupilId: string, recipientId: string) {
    await this.auth('confirm');
    if (!this.identity) throw new SchoolFoxError('confirm', 'login_identity_required');
    const detail = await this.messageDetail(messageId);
    if (detail.pupilId !== pupilId) throw new SchoolFoxError('confirm', 'pupil_mismatch');
    const body = confirmationBody(detail, this.identity, pupilId, recipientId, this.now());
    const response = object(await this.request('confirm', 'PATCH', `tables/MessageRelatedPupils/${recipientId}`, body), 'confirm');
    if (requiredId(response.id, 'confirm') !== recipientId) throw new SchoolFoxError('confirm', 'unexpected_response');
    return response;
  }
}
