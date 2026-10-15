import { basename } from 'node:path';
import { type Config } from './config.js';
import { SchoolFoxError, idSchema, list, object, requiredId, quoteId, type RecordData } from './contracts.js';
import { confirmationBody, replyBody } from './writes.js';
import { SchoolFoxTransport } from './transport.js';
import { ChatFeatureClient } from './chats.js';
import { AbsenceFeatureClient } from './absences.js';
import { SchedulingFeatureClient } from './scheduling.js';

export class SchoolFoxClient extends SchoolFoxTransport {
  readonly absences = new AbsenceFeatureClient(this, () => this.now());
  readonly chats = new ChatFeatureClient(this);
  readonly scheduling = new SchedulingFeatureClient(this);
  constructor(config: Config, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()) { super(config, fetcher, now); }
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
    const apiUrl = new URL(`api/Files/Messages/${id}`, 'https://api.schoolfox.com/');
    apiUrl.searchParams.set('fileName', attachmentName);
    const { bytes, contentType } = await this.downloadSigned(operation, apiUrl.pathname.slice(1) + apiUrl.search, selected.size);
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
    await this.ensureAuthenticated('reply');
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
    await this.ensureAuthenticated('confirm');
    if (!this.identity) throw new SchoolFoxError('confirm', 'login_identity_required');
    const detail = await this.messageDetail(messageId);
    if (detail.pupilId !== pupilId) throw new SchoolFoxError('confirm', 'pupil_mismatch');
    const body = confirmationBody(detail, this.identity, pupilId, recipientId, this.now());
    const response = object(await this.request('confirm', 'PATCH', `tables/MessageRelatedPupils/${recipientId}`, body), 'confirm');
    if (requiredId(response.id, 'confirm') !== recipientId) throw new SchoolFoxError('confirm', 'unexpected_response');
    return response;
  }
}
