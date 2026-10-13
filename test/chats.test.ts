import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatFeatureClient } from '../src/chats.js';
import { loadConfig } from '../src/config.js';
import { SchoolFoxTransport } from '../src/transport.js';

type Captured = { url: URL; init: RequestInit };
const conversation = { id: 'chatA', organizationId: 'schoolA', topic: 'Mitteilungen der Schulleitung', isClosed: false, conversationUserRole: 'Member', isReadOnlyForMembers: false };
const fileMessage = { id: 'messageA', conversationId: 'chatA', messageType: 'File', params: ['attachmentA', 'report.pdf', 'true'] };

function fixture(routes: Record<string, unknown | (() => Response)>, env: Record<string, string> = {}) {
  const calls: Captured[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)); calls.push({ url, init });
    const route = `${init.method} ${url.pathname}`;
    const value = routes[route];
    if (value === undefined) return new Response('', { status: 404 });
    return typeof value === 'function' ? value() : Response.json(value);
  };
  const transport = new SchoolFoxTransport(loadConfig({ SCHOOLFOX_TOKEN: 'token', ...env }), fetcher as typeof fetch);
  return { chats: new ChatFeatureClient(transport), calls };
}

test('organization, conversation, and history reads use distinct first-party routes and exact scope', async () => {
  const { chats, calls } = fixture({
    'GET /api/OrganizationsForConversations': [{ id: 'schoolA' }],
    'GET /tables/Conversations': { results: [conversation], count: 1 },
    'GET /tables/Conversations/chatA': conversation,
    'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 }
  });
  assert.equal((await chats.organizations())[0]?.id, 'schoolA');
  assert.equal((await chats.conversations('schoolA', 25, 0)).results[0]?.topic, 'Mitteilungen der Schulleitung');
  assert.equal((await chats.history('schoolA', 'chatA', 100, 0)).results[0]?.id, 'messageA');
  assert.equal(calls[0]?.url.searchParams.get('applicationType'), 'SchoolFox');
  assert.equal(calls[1]?.url.searchParams.get('$filter'), "Deleted eq false and OrganizationId eq 'schoolA'");
  assert.equal(calls[3]?.url.searchParams.get('$filter'), "ConversationId eq 'chatA'");
  assert.equal(calls[3]?.url.searchParams.get('$top'), '100');
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`), [
    'GET /api/OrganizationsForConversations', 'GET /tables/Conversations', 'GET /tables/Conversations/chatA', 'GET /tables/ConversationMessages'
  ]);
});

test('message detail pages the conversation collection and rejects missing or mismatched records', async () => {
  const good = fixture({
    'GET /tables/Conversations/chatA': conversation,
    'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 },
    'GET /tables/ConversationMessages/messageA': () => new Response(null, { status: 404 })
  });
  assert.deepEqual(await good.chats.messageDetail('schoolA', 'chatA', 'messageA'), fileMessage);
  assert.deepEqual(good.calls.map(call => call.url.pathname), ['/tables/Conversations/chatA', '/tables/ConversationMessages']);
  const query = good.calls[1]!.url.searchParams;
  assert.equal(query.get('$filter'), "ConversationId eq 'chatA'");
  assert.equal(query.get('$top'), '50');
  assert.equal(query.get('$skip'), '0');
  assert.equal(query.get('$inlinecount'), 'allpages');

  for (const [result, code] of [
    [{ results: [], count: 0 }, 'message_not_found'],
    [{ results: [fileMessage, fileMessage], count: 2 }, 'unexpected_response'],
    [{ results: [{ ...fileMessage, id: 'messageB' }], count: 1 }, 'message_not_found'],
    [{ results: [{ ...fileMessage, conversationId: 'chatB' }], count: 1 }, 'conversation_mismatch']
  ] as const) {
    const fixtureCase = fixture({ 'GET /tables/Conversations/chatA': conversation, 'GET /tables/ConversationMessages': result });
    await assert.rejects(fixtureCase.chats.messageDetail('schoolA', 'chatA', 'messageA'), new RegExp(code));
    assert.equal(fixtureCase.calls.length, 2);
  }
});

test('message detail finds a later page and rejects incomplete or repeated pages', async () => {
  const calls: Captured[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === '/tables/Conversations/chatA') return Response.json(conversation);
    const skip = url.searchParams.get('$skip');
    if (skip === '0') return Response.json({ results: [{ id: 'otherA', conversationId: 'chatA' }], count: 2 });
    if (skip === '1') return Response.json({ results: [fileMessage], count: 2 });
    return new Response(null, { status: 404 });
  };
  const chats = new ChatFeatureClient(new SchoolFoxTransport(loadConfig({ SCHOOLFOX_TOKEN: 'token' }), fetcher as typeof fetch));
  assert.deepEqual(await chats.messageDetail('schoolA', 'chatA', 'messageA'), fileMessage);
  assert.deepEqual(calls.filter(call => call.url.pathname === '/tables/ConversationMessages').map(call => call.url.searchParams.get('$skip')), ['0', '1']);

  let pages = 0;
  const repeated = fixture({
    'GET /tables/Conversations/chatA': conversation,
    'GET /tables/ConversationMessages': () => Response.json({ results: [{ id: 'otherA', conversationId: 'chatA' }], count: 2 })
  });
  await assert.rejects(repeated.chats.messageDetail('schoolA', 'chatA', 'messageA'), /unexpected_response/);
  pages = repeated.calls.filter(call => call.url.pathname === '/tables/ConversationMessages').length;
  assert.equal(pages, 2);

  const short = fixture({ 'GET /tables/Conversations/chatA': conversation, 'GET /tables/ConversationMessages': { results: [], count: 1 } });
  await assert.rejects(short.chats.messageDetail('schoolA', 'chatA', 'messageA'), /unexpected_response/);
  assert.equal(short.calls.length, 2);

  const overLimit = fixture({ 'GET /tables/Conversations/chatA': conversation, 'GET /tables/ConversationMessages': { results: [fileMessage], count: 1051 } });
  assert.deepEqual(await overLimit.chats.messageDetail('schoolA', 'chatA', 'messageA'), fileMessage);
  assert.equal(overLimit.calls.length, 2);

  const boundedCalls: Captured[] = [];
  const boundedFetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); boundedCalls.push({ url, init });
    if (url.pathname === '/tables/Conversations/chatA') return Response.json(conversation);
    const skip = Number(url.searchParams.get('$skip'));
    return Response.json({ results: Array.from({ length: 50 }, (_, index) => ({ id: `other${skip + index}`, conversationId: 'chatA' })), count: 1051 });
  };
  const bounded = new ChatFeatureClient(new SchoolFoxTransport(loadConfig({ SCHOOLFOX_TOKEN: 'token' }), boundedFetcher as typeof fetch));
  await assert.rejects(bounded.messageDetail('schoolA', 'chatA', 'messageA'), /pagination_limit_exceeded/);
  assert.deepEqual(boundedCalls.filter(call => call.url.pathname === '/tables/ConversationMessages').map(call => Number(call.url.searchParams.get('$skip'))), Array.from({ length: 21 }, (_, index) => index * 50));
});

test('text send uses exact body and one POST after fresh conversation and reply checks', async () => {
  const { chats, calls } = fixture({
    'GET /tables/Conversations/chatA': conversation,
    'GET /tables/ConversationMessages': { results: [{ id: 'messageA', conversationId: 'chatA', messageType: 'Text' }], count: 1 },
    'POST /tables/ConversationMessages': { id: 'sentA', conversationId: 'chatA' }
  });
  assert.equal((await chats.sendText('schoolA', 'chatA', 'Exact text', 'messageA')).id, 'sentA');
  const writes = calls.filter(x => x.init.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(String(writes[0]?.init.body)), {
    organizationId: 'schoolA', conversationId: 'chatA', content: 'Exact text', inReplyToId: 'messageA'
  });
});

test('closed, readonly, unknown role, and wrong school block writes', async () => {
  for (const changed of [
    { isClosed: true }, { conversationUserRole: 'Readonly' }, { conversationUserRole: 'Unknown' },
    { isReadOnlyForMembers: true }, { organizationId: 'schoolB' }
  ]) {
    const { chats, calls } = fixture({ 'GET /tables/Conversations/chatA': { ...conversation, ...changed }, 'POST /tables/ConversationMessages': { id: 'bad' } });
    await assert.rejects(chats.sendText('schoolA', 'chatA', 'Text'));
    assert.equal(calls.some(x => x.init.method === 'POST'), false);
  }
});

test('reply lookup cannot make an earlier writable conversation state authorize either send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schoolfox-chat-stale-'));
  try {
    const path = join(dir, 'note.txt'); await writeFile(path, 'abc');
    for (const kind of ['text', 'attachment'] as const) {
      let details = 0;
      const { chats, calls } = fixture({
        'GET /tables/Conversations/chatA': () => Response.json({ ...conversation, ...(++details === 1 ? {} : { isClosed: true }) }),
        'GET /tables/ConversationMessages': { results: [{ id: 'messageA', conversationId: 'chatA', messageType: 'Text' }], count: 1 },
        'POST /tables/ConversationMessages': { id: 'unexpected' },
        'POST /api/conversations/chatA/attach': [{ id: 'attachmentA', messageId: 'messageB' }]
      });
      await assert.rejects(kind === 'text'
        ? chats.sendText('schoolA', 'chatA', 'Text', 'messageA')
        : chats.sendAttachment('schoolA', 'chatA', path, '', 'messageA'), /conversation_closed/);
      assert.equal(details, 2);
      assert.equal(calls.some(call => call.init.method === 'POST'), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file send uploads one bounded local file then sends the returned message once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schoolfox-chat-'));
  try {
    const path = join(dir, 'note.txt');
    await writeFile(path, 'Attachment bytes');
    const { chats, calls } = fixture({
      'GET /tables/Conversations/chatA': conversation,
      'POST /api/conversations/chatA/attach': [{ id: 'attachmentA', messageId: 'messageA', isMalware: false }],
      'POST /api/Conversations/chatA/messages/messageA/send': { id: 'messageA' }
    });
    assert.equal((await chats.sendAttachment('schoolA', 'chatA', path, 'Attached')).messageId, 'messageA');
    const upload = calls.find(x => x.url.pathname.endsWith('/attach'))!;
    assert.equal(upload.url.searchParams.get('organizationId'), 'schoolA');
    assert.equal(upload.init.body instanceof FormData, true);
    const part = (upload.init.body as FormData).get('file[0]');
    assert.ok(part instanceof Blob);
    assert.equal((part as Blob & { name: string }).name, 'note.txt');
    assert.equal(new TextDecoder().decode(await part.arrayBuffer()), 'Attachment bytes');
    const send = calls.find(x => x.url.pathname.endsWith('/send'))!;
    assert.deepEqual(JSON.parse(String(send.init.body)), {
      organizationId: 'schoolA', conversationId: 'chatA', content: 'Attached', inReplyToId: null, messageId: 'messageA'
    });
    assert.equal(calls.filter(x => x.init.method === 'POST').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsafe upload and failed second step cannot repeat a remote write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schoolfox-chat-'));
  try {
    const path = join(dir, 'note.txt'); await writeFile(path, 'abc');
    const oversized = fixture({ 'GET /tables/Conversations/chatA': conversation }, { SCHOOLFOX_MAX_UPLOAD_BYTES: '1024' });
    await assert.rejects(oversized.chats.sendAttachment('schoolA', 'chatA', 'relative.txt'), /absolute_path_required/);
    assert.equal(oversized.calls.some(x => x.init.method === 'POST'), false);
    const largePath = join(dir, 'large.txt'); await writeFile(largePath, new Uint8Array(1025));
    await assert.rejects(oversized.chats.sendAttachment('schoolA', 'chatA', largePath), /file_too_large/);
    const linkPath = join(dir, 'link.txt'); await symlink(path, linkPath);
    await assert.rejects(oversized.chats.sendAttachment('schoolA', 'chatA', linkPath), /unsafe_file/);
    if (process.platform !== 'win32') {
      const pipePath = join(dir, 'pipe');
      execFileSync('mkfifo', [pipePath]);
      await assert.rejects(oversized.chats.sendAttachment('schoolA', 'chatA', pipePath), /unsafe_file/);
    }
    assert.equal(oversized.calls.some(x => x.init.method === 'POST'), false);
    const failed = fixture({
      'GET /tables/Conversations/chatA': conversation,
      'POST /api/conversations/chatA/attach': [{ id: 'attachmentA', messageId: 'messageA' }],
      'POST /api/Conversations/chatA/messages/messageA/send': () => new Response('', { status: 500 })
    });
    await assert.rejects(failed.chats.sendAttachment('schoolA', 'chatA', path), /attachment_send_incomplete/);
    assert.equal(failed.calls.filter(x => x.url.pathname.endsWith('/send')).length, 1);
    const malware = fixture({ 'GET /tables/Conversations/chatA': conversation, 'POST /api/conversations/chatA/attach': [{ id: 'attachmentA', messageId: 'messageA', isMalware: true }] });
    await assert.rejects(malware.chats.sendAttachment('schoolA', 'chatA', path), /attachment_send_incomplete/);
    assert.equal(malware.calls.some(x => x.url.pathname.endsWith('/send')), false);
    for (const uploaded of [
      { id: 'attachmentA', messageId: 'messageA', conversationId: 'chatB' },
      { messageId: 'messageA', conversationId: 'chatA' },
      { id: 'invalid id', messageId: 'messageA', conversationId: 'chatA' }
    ]) {
      const mismatch = fixture({ 'GET /tables/Conversations/chatA': conversation, 'POST /api/conversations/chatA/attach': [uploaded] });
      await assert.rejects(mismatch.chats.sendAttachment('schoolA', 'chatA', path), /attachment_send_incomplete/);
      assert.equal(mismatch.calls.filter(call => call.url.pathname.endsWith('/send')).length, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('attachment download checks exact file message and saves one bounded file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schoolfox-chat-download-'));
  try {
    const routes = {
      'GET /tables/Conversations/chatA': conversation,
      'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 },
      'GET /api/conversations/chatA/attachments/attachmentA': () => new Response('PDF bytes')
    };
    const { chats, calls } = fixture(routes, { SCHOOLFOX_DOWNLOAD_DIR: dir });
    const saved = await chats.downloadAttachment('schoolA', 'chatA', 'messageA', 'attachmentA');
    assert.equal(await readFile(saved.path, 'utf8'), 'PDF bytes');
    await assert.rejects(chats.downloadAttachment('schoolA', 'chatA', 'messageA', 'attachmentA'), /file_exists_or_unwritable/);
    assert.equal(calls.find(x => x.url.pathname.endsWith('/attachmentA'))?.url.searchParams.get('organizationId'), 'schoolA');
    const wrong = fixture({ 'GET /tables/Conversations/chatA': conversation, 'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 } });
    await assert.rejects(wrong.chats.downloadAttachment('schoolA', 'chatA', 'messageA', 'other'), /attachment_not_found/);
    assert.equal(wrong.calls.some(x => x.url.pathname.includes('/attachments/')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('chat attachment follows one approved signed redirect without forwarding credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schoolfox-chat-redirect-'));
  try {
    const signed = 'https://getfile.foxeducation.com/opaque?signature=private-value';
    const { chats, calls } = fixture({
      'GET /tables/Conversations/chatA': conversation,
      'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 },
      'GET /api/conversations/chatA/attachments/attachmentA': () => new Response(null, { status: 302, headers: { location: signed } }),
      'GET /opaque': () => new Response('PDF bytes', { headers: { 'content-type': 'application/pdf' } })
    }, { SCHOOLFOX_DOWNLOAD_DIR: dir });
    const saved = await chats.downloadAttachment('schoolA', 'chatA', 'messageA', 'attachmentA');
    assert.equal(await readFile(saved.path, 'utf8'), 'PDF bytes');
    assert.equal(saved.contentType, 'application/pdf');
    const fileHost = calls.find(call => call.url.origin === 'https://getfile.foxeducation.com')!;
    assert.equal(fileHost.init.headers, undefined);
    assert.equal(fileHost.init.credentials, 'omit');
    assert.equal(fileHost.init.redirect, 'manual');
    assert.ok(!JSON.stringify(saved).includes('private-value'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('chat attachment rejects hostile and repeated signed redirects', async () => {
  for (const [location, signedResponse] of [
    ['https://evil.example/file?secret=private', undefined],
    ['https://getfile.foxeducation.com/opaque?secret=private', new Response(null, { status: 302, headers: { location: 'https://getfile.foxeducation.com/second' } })]
  ] as const) {
    const { chats, calls } = fixture({
      'GET /tables/Conversations/chatA': conversation,
      'GET /tables/ConversationMessages': { results: [fileMessage], count: 1 },
      'GET /api/conversations/chatA/attachments/attachmentA': () => new Response(null, { status: 302, headers: { location } }),
      ...(signedResponse ? { 'GET /opaque': () => signedResponse } : {})
    });
    await assert.rejects(chats.downloadAttachment('schoolA', 'chatA', 'messageA', 'attachmentA'), /redirect_rejected/);
    assert.equal(calls.some(call => call.url.hostname === 'evil.example'), false);
    assert.equal(calls.some(call => call.url.pathname === '/second'), false);
  }
});
