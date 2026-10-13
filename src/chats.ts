import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SchoolFoxError, idSchema, list, object, pageSchema, requiredId, quoteId, type RecordData } from './contracts.js';
import { SchoolFoxTransport } from './transport.js';

const chatPage = z.object({ top: z.number().int().min(1).max(50).default(25), skip: pageSchema.shape.skip });
const historyPage = z.object({ top: z.number().int().min(1).max(100).default(100), skip: pageSchema.shape.skip });
const textSchema = z.string().min(1).max(10000);

function exactObject(value: unknown, id: string, operation: string): RecordData {
  const row = object(value, operation);
  if (requiredId(row.id, operation) !== id) throw new SchoolFoxError(operation, 'unexpected_response');
  return row;
}

function writeAllowed(conversation: RecordData, operation: string): void {
  if (conversation.isClosed !== false) throw new SchoolFoxError(operation, conversation.isClosed === true ? 'conversation_closed' : 'permission_unverified');
  const role = conversation.conversationUserRole;
  if (role !== 'Admin' && role !== 'Member') throw new SchoolFoxError(operation, role === 'Readonly' ? 'read_only' : 'permission_unverified');
  if (role === 'Member' && conversation.isReadOnlyForMembers !== false) throw new SchoolFoxError(operation, conversation.isReadOnlyForMembers === true ? 'read_only' : 'permission_unverified');
}

function odataPath(table: string, filter: string, top: number, skip: number): string {
  const params = new URLSearchParams({ '$filter': filter, '$inlinecount': 'allpages', '$top': String(top), '$skip': String(skip) });
  return `${table}?${params.toString()}`;
}

export class ChatFeatureClient {
  constructor(private transport: SchoolFoxTransport) {}

  async organizations() {
    const operation = 'chat_organizations';
    const rows = await this.transport.request(operation, 'GET', 'api/OrganizationsForConversations?applicationType=SchoolFox');
    if (!Array.isArray(rows)) throw new SchoolFoxError(operation, 'unexpected_response');
    return rows.map(value => { const row = object(value, operation); requiredId(row.id, operation); return row; });
  }

  async conversations(schoolId: string, top: number, skip: number) {
    const operation = 'chat_conversations';
    const filter = `Deleted eq false and OrganizationId eq ${quoteId(schoolId)}`;
    const path = odataPath('tables/Conversations', filter, top, skip);
    const page = list(await this.transport.request(operation, 'GET', path), operation);
    for (const row of page.results) if (row.organizationId !== schoolId) throw new SchoolFoxError(operation, 'school_mismatch');
    return page;
  }

  async conversationDetail(schoolId: string, conversationId: string) {
    const operation = 'chat_conversation_detail';
    const row = exactObject(await this.transport.request(operation, 'GET', `tables/Conversations/${idSchema.parse(conversationId)}`), conversationId, operation);
    if (row.organizationId !== schoolId) throw new SchoolFoxError(operation, 'school_mismatch');
    return row;
  }

  async history(schoolId: string, conversationId: string, top: number, skip: number) {
    const operation = 'chat_history';
    await this.conversationDetail(schoolId, conversationId);
    const path = odataPath('tables/ConversationMessages', `ConversationId eq ${quoteId(conversationId)}`, top, skip);
    const page = list(await this.transport.request(operation, 'GET', path), operation);
    for (const row of page.results) if (row.conversationId !== conversationId) throw new SchoolFoxError(operation, 'conversation_mismatch');
    return page;
  }

  async messageDetail(schoolId: string, conversationId: string, messageId: string) {
    const operation = 'chat_message_detail';
    await this.conversationDetail(schoolId, conversationId);
    const target = idSchema.parse(messageId);
    const pageSize = 50;
    const maxPages = 21;
    const seen = new Set<string>();
    let expectedCount: number | undefined;
    let match: RecordData | undefined;
    let skip = 0;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const path = odataPath('tables/ConversationMessages', `ConversationId eq ${quoteId(conversationId)}`, pageSize, skip);
      const page = list(await this.transport.request(operation, 'GET', path), operation);
      if (expectedCount === undefined) expectedCount = page.count;
      if (page.count !== expectedCount || page.results.length > pageSize || skip + page.results.length > page.count || (page.results.length === 0 && skip < page.count)) {
        throw new SchoolFoxError(operation, 'unexpected_response');
      }
      for (const row of page.results) {
        if (row.conversationId !== conversationId) throw new SchoolFoxError(operation, 'conversation_mismatch');
        const id = row.id as string;
        if (seen.has(id)) throw new SchoolFoxError(operation, 'unexpected_response');
        seen.add(id);
        if (id === target) {
          if (match) throw new SchoolFoxError(operation, 'unexpected_response');
          match = row;
        }
      }
      if (match) return match;
      skip += page.results.length;
      if (skip === page.count) {
        throw new SchoolFoxError(operation, 'message_not_found');
      }
    }
    throw new SchoolFoxError(operation, 'pagination_limit_exceeded');
  }

  async sendText(schoolId: string, conversationId: string, content: string, inReplyToId?: string) {
    const operation = 'chat_send';
    if (inReplyToId) await this.messageDetail(schoolId, conversationId, inReplyToId);
    const conversation = await this.conversationDetail(schoolId, conversationId);
    writeAllowed(conversation, operation);
    const body = { organizationId: schoolId, conversationId, content: textSchema.parse(content), inReplyToId: inReplyToId ?? null };
    const row = object(await this.transport.request(operation, 'POST', 'tables/ConversationMessages', body), operation);
    requiredId(row.id, operation);
    if (row.conversationId !== undefined && row.conversationId !== conversationId) throw new SchoolFoxError(operation, 'unexpected_response');
    return row;
  }

  private async localFile(path: string): Promise<{ name: string; bytes: Uint8Array }> {
    const operation = 'chat_attachment_send';
    if (!isAbsolute(path)) throw new SchoolFoxError(operation, 'absolute_path_required');
    const name = this.transport.nativeFileName(basename(path), operation);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new SchoolFoxError(operation, 'unsafe_file'); }
    try {
      const stat = await handle.stat();
      const limit = this.transport.config.maxUploadBytes;
      if (!stat.isFile() || stat.size < 1) throw new SchoolFoxError(operation, 'unsafe_file');
      if (stat.size > limit) throw new SchoolFoxError(operation, 'file_too_large');
      const bytes = new Uint8Array(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > limit) throw new SchoolFoxError(operation, 'file_too_large');
      if (offset !== stat.size) throw new SchoolFoxError(operation, 'file_changed');
      return { name, bytes: bytes.subarray(0, offset) };
    } finally { await handle.close(); }
  }

  async sendAttachment(schoolId: string, conversationId: string, path: string, content = '', inReplyToId?: string) {
    const operation = 'chat_attachment_send';
    if (inReplyToId) await this.messageDetail(schoolId, conversationId, inReplyToId);
    const conversation = await this.conversationDetail(schoolId, conversationId);
    writeAllowed(conversation, operation);
    if (content.length > 10000) throw new SchoolFoxError(operation, 'content_too_long');
    const { name, bytes } = await this.localFile(path);
    const form = new FormData();
    form.append('file[0]', new Blob([Uint8Array.from(bytes).buffer as ArrayBuffer], { type: 'application/octet-stream' }), name);
    const uploadPath = `api/conversations/${idSchema.parse(conversationId)}/attach?organizationId=${encodeURIComponent(idSchema.parse(schoolId))}`;
    let messageId: string;
    try {
      const uploaded = await this.transport.uploadMultipart(operation, uploadPath, form);
      if (!Array.isArray(uploaded) || uploaded.length !== 1) throw new SchoolFoxError(operation, 'attachment_send_incomplete');
      const attachment = object(uploaded[0], operation);
      requiredId(attachment.id, operation);
      if (attachment.isMalware !== false && attachment.isMalware !== undefined) throw new SchoolFoxError(operation, 'attachment_send_incomplete');
      if (attachment.organizationId !== undefined && attachment.organizationId !== schoolId) throw new SchoolFoxError(operation, 'attachment_send_incomplete');
      if (attachment.conversationId !== undefined && attachment.conversationId !== conversationId) throw new SchoolFoxError(operation, 'attachment_send_incomplete');
      messageId = requiredId(attachment.messageId, operation);
      const body = { organizationId: schoolId, conversationId, content, inReplyToId: inReplyToId ?? null, messageId };
      const row = object(await this.transport.request(operation, 'POST', `api/Conversations/${idSchema.parse(conversationId)}/messages/${messageId}/send`, body), operation);
      if (row.id !== undefined && row.id !== messageId) throw new SchoolFoxError(operation, 'attachment_send_incomplete');
      return { messageId, response: row };
    } catch { throw new SchoolFoxError(operation, 'attachment_send_incomplete'); }
  }

  async downloadAttachment(schoolId: string, conversationId: string, messageId: string, attachmentId: string, fileName?: string) {
    const operation = 'chat_attachment_download';
    const row = await this.messageDetail(schoolId, conversationId, messageId);
    if (row.messageType !== 'File' || !Array.isArray(row.params) || row.params.length % 3 !== 0) throw new SchoolFoxError(operation, 'attachment_not_found');
    const matches: string[] = [];
    for (let i = 0; i < row.params.length; i += 3) {
      if (row.params[i] === attachmentId && typeof row.params[i + 1] === 'string') matches.push(row.params[i + 1] as string);
    }
    if (matches.length !== 1) throw new SchoolFoxError(operation, 'attachment_not_found');
    const localName = this.transport.nativeFileName(fileName ?? matches[0]!, operation);
    const path = `api/conversations/${idSchema.parse(conversationId)}/attachments/${idSchema.parse(attachmentId)}?organizationId=${encodeURIComponent(idSchema.parse(schoolId))}`;
    const { bytes, contentType } = await this.transport.downloadSigned(operation, path);
    return { ...await this.transport.saveDownload(localName, bytes, operation), contentType };
  }
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(error instanceof SchoolFoxError ? error.toJSON() : { operation: 'tool', code: 'invalid_input_or_internal_error' }) }], isError: true });
const safe = async (fn: () => Promise<unknown>) => { try { return result(await fn()); } catch (error) { return failure(error); } };

export function registerChatTools(server: McpServer, client: ChatFeatureClient): void {
  const id = idSchema;
  const target = z.object({ schoolId: id, conversationId: id });
  server.registerTool('schoolfox_chat_organizations', { description: 'List schools available for standalone SchoolFox conversations.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, () => safe(() => client.organizations()));
  server.registerTool('schoolfox_conversations', { description: 'List standalone conversations for one school, including a school-leadership conversation if the account returns it.', inputSchema: z.object({ schoolId: id }).extend(chatPage.shape), annotations: { readOnlyHint: true } }, ({ schoolId, top, skip }) => safe(() => client.conversations(schoolId, top, skip)));
  server.registerTool('schoolfox_conversation_detail', { description: 'Get exact standalone conversation metadata. General GET read-state effects are unverified.', inputSchema: target, annotations: { readOnlyHint: false } }, ({ schoolId, conversationId }) => safe(() => client.conversationDetail(schoolId, conversationId)));
  server.registerTool('schoolfox_chat_history', { description: 'Get one bounded page of standalone conversation messages. General GET read-state effects are unverified.', inputSchema: target.extend(historyPage.shape), annotations: { readOnlyHint: false } }, ({ schoolId, conversationId, top, skip }) => safe(() => client.history(schoolId, conversationId, top, skip)));
  server.registerTool('schoolfox_chat_message_detail', { description: 'Get one exact conversation message to inspect its attachments. General GET read-state effects are unverified.', inputSchema: target.extend({ messageId: id }), annotations: { readOnlyHint: false } }, ({ schoolId, conversationId, messageId }) => safe(() => client.messageDetail(schoolId, conversationId, messageId)));
  server.registerTool('schoolfox_chat_send', { description: 'Send exact text once to an existing writable conversation. This creates a real message for its participants.', inputSchema: target.extend({ content: textSchema, inReplyToId: id.optional() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, ({ schoolId, conversationId, content, inReplyToId }) => safe(() => client.sendText(schoolId, conversationId, content, inReplyToId)));
  server.registerTool('schoolfox_chat_send_attachment', { description: 'Upload one bounded local regular file, then send its attachment message once to an existing writable conversation. An error can leave an uploaded draft attachment.', inputSchema: target.extend({ path: z.string().min(1).max(4096), content: z.string().max(10000).default(''), inReplyToId: id.optional() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, ({ schoolId, conversationId, path, content, inReplyToId }) => safe(() => client.sendAttachment(schoolId, conversationId, path, content, inReplyToId)));
  server.registerTool('schoolfox_chat_download_attachment', { description: 'Download one exact file attachment from a returned conversation message into a new local file. Refuses overwrite.', inputSchema: target.extend({ messageId: id, attachmentId: id, fileName: z.string().min(1).max(255).optional() }), annotations: { readOnlyHint: false, destructiveHint: false } }, ({ schoolId, conversationId, messageId, attachmentId, fileName }) => safe(() => client.downloadAttachment(schoolId, conversationId, messageId, attachmentId, fileName)));
}
