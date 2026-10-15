import { mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Config } from './config.js';
import { SchoolFoxError, object, requiredId, type RecordData } from './contracts.js';
import { type Identity } from './writes.js';

const BASE = 'https://api.schoolfox.com/';
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class SchoolFoxTransport {
  protected token?: string;
  protected identity?: Identity;
  private pendingToken?: string;
  private authState: 'idle' | 'ready' | 'two_factor_required' | 'two_factor_setup_required' | 'failed' = 'idle';
  private loginPromise?: Promise<void>;
  private recoveryPromise?: Promise<void>;
  private recoveryFailedToken?: string;

  constructor(public readonly config: Config, protected readonly fetcher: typeof fetch = fetch, protected readonly now: () => Date = () => new Date()) {
    this.token = config.token;
    if (this.token) this.authState = 'ready';
  }

  status() {
    return { configured: Boolean(this.token || (this.config.email && this.config.password)), mode: this.config.email ? 'login' : this.token ? 'token' : 'none', writeReady: Boolean(this.identity), detailGetReadState: 'unverified', authentication: this.authState };
  }

  requireIdentity(operation: string): Identity {
    if (!this.identity) throw new SchoolFoxError(operation, 'login_identity_required');
    return this.identity;
  }

  async ensureAuthenticated(operation: string): Promise<void> {
    if (this.recoveryPromise) await this.recoveryPromise;
    if (this.token) return;
    if (this.authState === 'two_factor_required' || this.authState === 'two_factor_setup_required') throw new SchoolFoxError(operation, this.authState);
    if (this.loginPromise) return this.loginPromise;
    if (this.authState === 'failed') throw new SchoolFoxError(operation, 'authentication_required');
    if (!this.config.email || !this.config.password) throw new SchoolFoxError(operation, 'credentials_required');
    this.loginPromise = this.login();
    try { await this.loginPromise; }
    finally { this.loginPromise = undefined; }
  }

  async authenticate(code?: string) {
    if (this.recoveryPromise) await this.recoveryPromise.catch(() => {});
    if (code !== undefined) {
      if (!this.pendingToken || this.authState !== 'two_factor_required') throw new SchoolFoxError('authenticate', 'two_factor_challenge_required');
      if (!code.trim() || code.length > 128) throw new SchoolFoxError('authenticate', 'invalid_code');
      const temporary = this.pendingToken;
      let data: unknown;
      try { data = await this.send('authenticate', 'POST', 'api/2fa/login', { password: code }, temporary); }
      catch (error) {
        if (error instanceof SchoolFoxError && (error.status === 400 || error.status === 401)) throw new SchoolFoxError('authenticate', 'invalid_code', error.status);
        throw error;
      }
      this.acceptLogin(data, 'authenticate', true);
      return this.status();
    }
    if (!this.config.email || !this.config.password) throw new SchoolFoxError('authenticate', 'credentials_required');
    if (this.loginPromise) await this.loginPromise.catch(error => {
      if (error instanceof SchoolFoxError && (error.code === 'two_factor_required' || error.code === 'two_factor_setup_required')) return;
      throw error;
    });
    else {
      this.token = undefined; this.identity = undefined; this.pendingToken = undefined; this.authState = 'idle';
      await this.ensureAuthenticated('authenticate').catch(error => {
        if (error instanceof SchoolFoxError && (error.code === 'two_factor_required' || error.code === 'two_factor_setup_required')) return;
        throw error;
      });
    }
    return this.status();
  }

  async renewSession() {
    if (this.recoveryPromise) { await this.recoveryPromise; return this.status(); }
    if (!this.token) return this.authenticate();
    await this.recover(this.token);
    return this.status();
  }

  private async login(): Promise<void> {
    try {
      const data = await this.send('login', 'POST', 'api/Users/login', { username: this.config.email, password: this.config.password, applicationType: 'SchoolFox' });
      this.acceptLogin(data, 'login');
    } catch (error) {
      if (this.authState !== 'two_factor_required' && this.authState !== 'two_factor_setup_required') this.authState = 'failed';
      throw error;
    }
  }

  private acceptLogin(data: unknown, operation: string, final2fa = false): void {
    const result = object(data, operation);
    const user = object(result.user, operation);
    if (typeof result.token !== 'string' || !result.token) throw new SchoolFoxError(operation, 'authentication_required');
    if (!final2fa && user.twoFactorAuthActive === true) {
      this.pendingToken = result.token;
      this.token = undefined; this.identity = undefined; this.authState = 'two_factor_required';
      throw new SchoolFoxError(operation, 'two_factor_required');
    }
    if (!final2fa && user.twoFactorAuthActive === false && user.twoFactorAuthStatus === 'Required') {
      this.pendingToken = undefined; this.token = undefined; this.identity = undefined; this.authState = 'two_factor_setup_required';
      throw new SchoolFoxError(operation, 'two_factor_setup_required');
    }
    if (user.twoFactorAuthActive !== false && !final2fa || (!final2fa && !['Optional', 'Disabled'].includes(String(user.twoFactorAuthStatus)))) throw new SchoolFoxError(operation, 'two_factor_state_unverified');
    const userId = requiredId(user.id, operation);
    const fullUsername = typeof user.firstName === 'string' && user.firstName.trim() && typeof user.lastName === 'string' && user.lastName.trim()
      ? `${user.firstName.trim()} ${user.lastName.trim()}`
      : typeof user.fullUsername === 'string' && user.fullUsername.trim() ? user.fullUsername.trim() : undefined;
    this.identity = fullUsername ? { id: userId, fullUsername } : undefined;
    this.token = result.token; this.pendingToken = undefined; this.authState = 'ready'; this.recoveryFailedToken = undefined;
  }

  private async recover(failedToken: string): Promise<void> {
    if (this.loginPromise) await this.loginPromise;
    if (this.token && this.token !== failedToken) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.recoveryFailedToken === failedToken) throw new SchoolFoxError('session_recovery', 'authentication_required');
    this.recoveryPromise = (async () => {
      this.identity = undefined;
      try {
        const data = await this.send('session_recovery', 'GET', 'api/Users/login/token', undefined, failedToken);
        this.acceptLogin(data, 'session_recovery', true);
      } catch (error) {
        if (!this.config.email || !this.config.password) {
          this.token = undefined; this.identity = undefined; this.authState = 'failed'; this.recoveryFailedToken = failedToken;
          throw new SchoolFoxError('session_recovery', 'authentication_required');
        }
        this.token = undefined; this.authState = 'idle';
        try { await this.login(); }
        catch (loginError) { this.recoveryFailedToken = failedToken; throw loginError; }
      }
    })();
    try { await this.recoveryPromise; }
    finally { this.recoveryPromise = undefined; }
  }

  protected async readBytes(response: Response, limit: number, operation: string): Promise<Uint8Array> {
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
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return bytes;
  }

  private url(path: string, operation: string): URL {
    const url = new URL(path, BASE);
    if (url.origin !== 'https://api.schoolfox.com' || (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tables/'))) throw new SchoolFoxError(operation, 'unsafe_path');
    return url;
  }

  private async send(operation: string, method: Method, path: string, body?: RecordData | string[], token?: string, binary = false): Promise<unknown> {
    const url = this.url(path, operation);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string,string> = { 'ZUMO-API-VERSION': '2.0.0' };
      if (token) headers['X-ZUMO-AUTH'] = token;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await this.fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new SchoolFoxError(operation, 'redirect_rejected', response.status); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new SchoolFoxError(operation, response.status === 401 ? 'authentication_required' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'http_error', response.status);
      }
      if (binary && response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new SchoolFoxError(operation, 'unexpected_response', response.status);
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

  async request(operation: string, method: Method, path: string, body?: RecordData | string[], authenticate = true, binary = false): Promise<unknown> {
    if (authenticate) await this.ensureAuthenticated(operation);
    const sentToken = authenticate ? this.token : undefined;
    try { return await this.send(operation, method, path, body, sentToken, binary); }
    catch (error) {
      if (!(error instanceof SchoolFoxError) || error.status !== 401 || !authenticate) throw error;
      if (method !== 'GET') { this.identity = undefined; throw error; }
      await this.recover(sentToken!);
      const retryToken = this.token;
      try { return await this.send(operation, method, path, body, retryToken, binary); }
      catch (retryError) {
        if (retryError instanceof SchoolFoxError && retryError.status === 401 && this.token === retryToken) {
          this.identity = undefined; this.token = undefined; this.authState = 'failed';
        }
        throw retryError;
      }
    }
  }

  async uploadMultipart(operation: string, path: string, form: FormData): Promise<unknown> {
    await this.ensureAuthenticated(operation);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(this.url(path, operation), {
        method: 'POST', body: form, redirect: 'manual', signal: controller.signal,
        headers: { 'X-ZUMO-AUTH': this.token!, 'ZUMO-API-VERSION': '2.0.0' }
      });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new SchoolFoxError(operation, 'redirect_rejected', response.status); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) this.identity = undefined;
        throw new SchoolFoxError(operation, response.status === 401 ? 'authentication_required' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'http_error', response.status);
      }
      const bytes = await this.readBytes(response, this.config.maxResponseBytes, operation);
      if (!bytes.length) return {};
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new SchoolFoxError(operation, 'invalid_json'); }
    } catch (error) {
      if (error instanceof SchoolFoxError) throw error;
      throw new SchoolFoxError(operation, controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }

  query(path: string, filter: string, order: string, top: number, skip: number): string {
    const url = this.url(path, 'query');
    url.searchParams.set('$filter', filter); url.searchParams.set('$orderby', order);
    url.searchParams.set('$top', String(top)); url.searchParams.set('$skip', String(skip)); url.searchParams.set('$inlinecount', 'allpages');
    return url.pathname.slice(1) + url.search;
  }

  nativeFileName(name: string, operation = 'message_attachment_download'): string {
    if (!name || name === '.' || name === '..' || Buffer.byteLength(name, 'utf8') > 255 || /[\\/\x00-\x1f\x7f]/u.test(name)) throw new SchoolFoxError(operation, 'unsafe_filename');
    return name;
  }

  async saveDownload(name: string, bytes: Uint8Array, operation: string) {
    await mkdir(this.config.downloadDir, { recursive: true, mode: 0o700 });
    const target = join(resolve(this.config.downloadDir), name);
    const handle = await open(target, 'wx', 0o600).catch(() => { throw new SchoolFoxError(operation, 'file_exists_or_unwritable'); });
    try { await handle.writeFile(bytes); await handle.close(); }
    catch { await handle.close().catch(() => {}); await unlink(target).catch(() => {}); throw new SchoolFoxError(operation, 'file_write_failed'); }
    return { path: target, bytes: bytes.length };
  }

  async downloadSigned(operation: string, path: string, expectedBytes?: number): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    await this.ensureAuthenticated(operation);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const fetchFile = async (token: string): Promise<Response> => this.fetcher(this.url(path, operation), { method:'GET', redirect:'manual', signal:controller.signal, headers:{'X-ZUMO-AUTH':token,'ZUMO-API-VERSION':'2.0.0'} });
      const sentToken = this.token!;
      let response = await fetchFile(sentToken);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        await this.recover(sentToken);
        response = await fetchFile(this.token!);
      }
      const finalApiToken = this.token;
      let fileResponse = response; let fromFileHost = false;
      if (response.status === 302) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        let redirectUrl: URL;
        try { redirectUrl = new URL(location ?? ''); } catch { throw new SchoolFoxError(operation, 'redirect_rejected'); }
        if (redirectUrl.origin !== 'https://getfile.foxeducation.com' || redirectUrl.username || redirectUrl.password || redirectUrl.port) throw new SchoolFoxError(operation, 'redirect_rejected');
        fileResponse = await this.fetcher(redirectUrl, { method:'GET', redirect:'manual', signal:controller.signal, credentials:'omit', referrerPolicy:'no-referrer' });
        fromFileHost = true;
      }
      if (fileResponse.status >= 300 && fileResponse.status < 400) { await fileResponse.body?.cancel().catch(() => {}); throw new SchoolFoxError(operation, 'redirect_rejected', fileResponse.status); }
      if (!fileResponse.ok) {
        await fileResponse.body?.cancel().catch(() => {});
        if (fileResponse.status === 401 && !fromFileHost && this.token === finalApiToken) { this.identity = undefined; this.token = undefined; this.authState = 'failed'; }
        throw new SchoolFoxError(operation, fileResponse.status === 401 && !fromFileHost ? 'authentication_required' : fileResponse.status === 403 ? 'forbidden' : fileResponse.status === 429 ? 'rate_limited' : 'http_error', fileResponse.status);
      }
      if (fileResponse.status !== 200) { await fileResponse.body?.cancel().catch(() => {}); throw new SchoolFoxError(operation, 'unexpected_response', fileResponse.status); }
      const contentType = fileResponse.headers.get('content-type');
      const bytes = await this.readBytes(fileResponse, this.config.maxDownloadBytes, operation);
      if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new SchoolFoxError(operation, 'attachment_size_mismatch');
      return { bytes, contentType };
    } catch (error) {
      if (error instanceof SchoolFoxError) throw error;
      throw new SchoolFoxError(operation, controller.signal.aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(timer); }
  }
}
