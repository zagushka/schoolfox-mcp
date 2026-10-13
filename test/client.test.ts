import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { SchoolFoxError } from '../src/contracts.js';

type Captured = { url: URL; init: RequestInit };
const login = { token: 'secret-token', user: { id: 'user1', fullUsername: 'Test Parent', twoFactorAuthActive:false, twoFactorAuthStatus:'Optional' } };
function fixture(routes: Record<string, unknown | (() => Response)>, env: Record<string,string> = { SCHOOLFOX_EMAIL: 'test@example.invalid', SCHOOLFOX_PASSWORD: 'test-password' }) {
  const calls: Captured[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    const key = `${init.method} ${url.pathname}`;
    const value = routes[key];
    if (value === undefined) return new Response('not found', { status: 404 });
    return typeof value === 'function' ? value() : Response.json(value);
  };
  const client = new SchoolFoxClient(loadConfig(env), fetcher as typeof fetch, () => new Date('2026-10-13T12:00:00.000Z'));
  return { client, calls };
}
const group = { id:'groupA', messageId:'msgA', pupilId:'pupilA', schoolClassId:'classA', isActive:true, pupilFullName:'Pupil A' };
const detail = { id:'msgA', pupilId:'pupilA', schoolClassId:'classA', instantMessagesAllowed:true, isOwned:false, instantMessagesCount:0, signatureRequired:false, info:[
  { id:'recipientA', pupilId:'pupilA', userId:'user1', signedByUserId:null, signingDate:null },
  { id:'recipientB', pupilId:'pupilB', userId:'user2', signedByUserId:null, signingDate:null }
] };

test('read filters one pupil and never sends explicit receipts', async () => {
  const { client, calls } = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages': { results: [], count: 0 } });
  assert.deepEqual(await client.messages('classA','pupilA',25,0), { results:[], count:0 });
  assert.match(calls[1]!.url.searchParams.get('$filter')!, /PupilId eq 'pupilA'/);
  assert.match(calls[1]!.url.searchParams.get('$filter')!, /SchoolClassId eq 'classA'/);
  assert.equal(calls[1]!.init.headers && (calls[1]!.init.headers as Record<string,string>)['X-ZUMO-AUTH'], 'secret-token');
  assert.equal(calls[1]!.url.searchParams.get('$top'), '25');
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`), ['POST /api/Users/login','GET /tables/Messages']);
});

test('reply sends one exact POST from validated group and login identity', async () => {
  const { info: _recipientRecords, ...message } = detail;
  const { client, calls } = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': message, 'GET /tables/InstantMessageGroups': {results:[group], count:1}, 'POST /tables/InstantMessages': { id:'reply1' } });
  assert.deepEqual(await client.reply('msgA','pupilA','groupA','Exact text'), {id:'reply1'});
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { MessageId:'msgA', PupilId:'pupilA', SchoolClassId:'classA', IsActive:true, Content:'Exact text', InstantMessageGroupId:'groupA', PupilFullName:'Pupil A', CreatorFullName:'Test Parent' });
  assert.equal(calls.filter(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages').length,1);
});

test('reply rejects wrong group and token-only identity without posting', async () => {
  const one = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': detail, 'GET /tables/InstantMessageGroups': {results:[{...group,pupilId:'pupilB'}],count:1} });
  await assert.rejects(one.client.reply('msgA','pupilA','groupA','Hello'), SchoolFoxError);
  assert.equal(one.calls.filter(x => x.url.pathname === '/tables/InstantMessages').length,0);
  const token = fixture({ 'GET /tables/Messages/msgA': detail, 'GET /tables/InstantMessageGroups': {results:[group],count:1} }, { SCHOOLFOX_TOKEN:'existing' });
  await assert.rejects(token.client.reply('msgA','pupilA','groupA','Hello'), /login_identity_required/);
});

test('confirmation refreshes detail and patches only selected recipient', async () => {
  const {client,calls} = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': detail, 'PATCH /tables/MessageRelatedPupils/recipientA': { id:'recipientA', signingDate:'2026-10-13T12:00:00.000Z' } });
  assert.equal((await client.confirm('msgA','pupilA','recipientA')).id,'recipientA');
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { ...detail.info[0], signedByUserId:'user1', signingDate:'2026-10-13T12:00:00.000Z' });
  assert.equal(calls[2]!.url.pathname, '/tables/MessageRelatedPupils/recipientA');
});

test('confirmation refuses signature, ambiguous recipient, and wrong user', async () => {
  for (const bad of [{...detail,signatureRequired:true},{...detail,info:[detail.info[0],detail.info[0]]},{...detail,info:[{...detail.info[0],userId:'other'}]}]) {
    const {client,calls} = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': bad });
    await assert.rejects(client.confirm('msgA','pupilA','recipientA'), SchoolFoxError);
    assert.equal(calls.some(x => x.init.method === 'PATCH'),false);
  }
});

test('authentication, HTTP failure, timeout, and response shape fail safely', async () => {
  const absent = fixture({}, {});
  await assert.rejects(absent.client.messages('classA','pupilA',1,0), /credentials_required/);
  const twoFactor = fixture({ 'POST /api/Users/login': { token:'temporary', user:{ ...login.user, twoFactorAuthActive:true } } });
  await assert.rejects(twoFactor.client.messages('classA','pupilA',1,0), /two_factor_unsupported/);
  assert.equal(twoFactor.calls.length,1);
  const forbidden = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages': () => new Response('',{status:403}) });
  await assert.rejects(forbidden.client.messages('classA','pupilA',1,0), (e: unknown) => e instanceof SchoolFoxError && e.status === 403);
  const limited = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages': () => new Response('',{status:429}) });
  await assert.rejects(limited.client.messages('classA','pupilA',1,0), /rate_limited/);
  const shape = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages': { items:[] } });
  await assert.rejects(shape.client.messages('classA','pupilA',1,0), /unexpected_response/);
  const timeout = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'x',SCHOOLFOX_TIMEOUT_MS:'1000'}), ((_u, init) => new Promise<Response>((_r,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch);
  await assert.rejects(timeout.messages('classA','pupilA',1,0), /timeout/);
});

test('file download is bounded, refuses redirect and overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-test-'));
  try {
    const env = {SCHOOLFOX_TOKEN:'token', SCHOOLFOX_DOWNLOAD_DIR:directory, SCHOOLFOX_MAX_DOWNLOAD_BYTES:'1024'};
    const detail = { id:'itemA', schoolClassId:'classA', files:[{id:'fileA'}] };
    const ok = fixture({ 'GET /api/FoxDriveItems/classA/Item/itemA':detail, 'GET /api/FoxDriveItems/itemA/DownloadFile/fileA': () => new Response('file bytes') }, env);
    const saved = await ok.client.downloadFile('classA','itemA','fileA','note.txt');
    assert.equal(await readFile(saved.path,'utf8'),'file bytes');
    await assert.rejects(ok.client.downloadFile('classA','itemA','fileA','note.txt'), /file_exists_or_unwritable/);
    await assert.rejects(ok.client.downloadFile('classA','itemA','fileA','..\/bad'), /unsafe_filename/);
    const redirect = fixture({ 'GET /api/FoxDriveItems/classA/Item/itemA':detail, 'GET /api/FoxDriveItems/itemA/DownloadFile/fileA': () => new Response('',{status:302,headers:{location:'https://evil.example/x'}}) }, env);
    await assert.rejects(redirect.client.downloadFile('classA','itemA','fileA','other.txt'), /redirect_rejected/);
    const large = fixture({ 'GET /api/FoxDriveItems/classA/Item/itemA':detail, 'GET /api/FoxDriveItems/itemA/DownloadFile/fileA': () => new Response(new Uint8Array(1025)) }, env);
    await assert.rejects(large.client.downloadFile('classA','itemA','fileA','large.txt'), /response_too_large/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('detail read does not explicitly mark read, confirm, or reply', async () => {
  const {client,calls} = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': detail });
  assert.equal((await client.messageDetail('msgA')).id,'msgA');
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`), ['POST /api/Users/login','GET /tables/Messages/msgA']);
});

test('detail without recipient records returns the message unchanged using only GET', async () => {
  const message = {id:'msgA',pupilId:'pupilA',schoolClassId:'classA',topic:'Fixture topic',content:'Fixture content',isRead:false};
  const {client,calls} = fixture({'GET /tables/Messages/msgA':message},{SCHOOLFOX_TOKEN:'fixture-token'});
  const returned = await client.messageDetail('msgA');
  assert.deepEqual(returned,message);
  assert.equal(Object.hasOwn(returned,'info'),false);
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['GET /tables/Messages/msgA']);
});

test('detail still rejects non-object responses and missing, invalid, or mismatched IDs', async () => {
  for (const value of [null,[],{}, {id:'invalid id'}, {id:'msgB'}]) {
    const {client,calls} = fixture({'GET /tables/Messages/msgA':value},{SCHOOLFOX_TOKEN:'fixture-token'});
    await assert.rejects(client.messageDetail('msgA'),/unexpected_response/);
    assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['GET /tables/Messages/msgA']);
  }
});

test('confirmation without an array of recipient records stops before PATCH', async () => {
  const {info: _recipientRecords,...message} = detail;
  for (const info of [undefined,null,{},'invalid']) {
    const response = info === undefined ? message : {...message,info};
    const {client,calls} = fixture({'POST /api/Users/login':login,'GET /tables/Messages/msgA':response});
    await assert.rejects(client.confirm('msgA','pupilA','recipientA'),/missing_recipient_records/);
    assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['POST /api/Users/login','GET /tables/Messages/msgA']);
  }
});

test('expired token and inactive group fail without a write', async () => {
  const expired = fixture({ 'GET /tables/Messages': () => new Response('',{status:401}) }, {SCHOOLFOX_TOKEN:'expired'});
  await assert.rejects(expired.client.messages('classA','pupilA',25,0), /authentication_required/);
  const inactive = fixture({ 'POST /api/Users/login': login, 'GET /tables/Messages/msgA': detail, 'GET /tables/InstantMessageGroups': {results:[{...group,isActive:false}],count:1} });
  await assert.rejects(inactive.client.reply('msgA','pupilA','groupA','Hello'), /reply_unavailable/);
  assert.equal(inactive.calls.some(x => x.url.pathname === '/tables/InstantMessages'),false);
});

test('simultaneous first reads share one login request', async () => {
  let finishLogin!: (response: Response) => void;
  const pendingLogin = new Promise<Response>(resolve => { finishLogin = resolve; });
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === '/api/Users/login') return pendingLogin;
    return Response.json({results:[],count:0});
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'test@example.invalid',SCHOOLFOX_PASSWORD:'test-password'}), fetcher as typeof fetch);
  const first = client.messages('classA','pupilA',25,0);
  const second = client.messages('classA','pupilB',25,0);
  assert.deepEqual(calls,['POST /api/Users/login']);
  finishLogin(Response.json(login));
  assert.deepEqual(await Promise.all([first,second]),[{results:[],count:0},{results:[],count:0}]);
  assert.equal(calls.filter(x => x === 'POST /api/Users/login').length,1);
  assert.equal(calls.filter(x => x === 'GET /tables/Messages').length,2);
});

test('failed shared login does not start a login loop', async () => {
  let finishLogin!: (response: Response) => void;
  const pendingLogin = new Promise<Response>(resolve => { finishLogin = resolve; });
  let logins = 0;
  const fetcher = async (): Promise<Response> => { logins++; return pendingLogin; };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'test@example.invalid',SCHOOLFOX_PASSWORD:'test-password'}), fetcher as typeof fetch);
  const first = client.messages('classA','pupilA',25,0);
  const second = client.messages('classA','pupilB',25,0);
  finishLogin(new Response('',{status:401}));
  const settled = await Promise.allSettled([first,second]);
  assert.ok(settled.every(x => x.status === 'rejected'));
  await assert.rejects(client.messages('classA','pupilA',25,0), /authentication_required/);
  assert.equal(logins,1);
});

test('rejected and oversized HTTP responses cancel their bodies', async () => {
  for (const responseKind of ['redirect','status','length','stream'] as const) {
    let cancellations = 0;
    const bytes = new Uint8Array(2048);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (responseKind === 'stream') controller.enqueue(bytes); },
      cancel() { cancellations++; }
    });
    const response = responseKind === 'redirect'
      ? new Response(body,{status:302,headers:{location:'https://example.invalid/'}})
      : responseKind === 'status'
      ? new Response(body,{status:403})
      : responseKind === 'length'
      ? new Response(body,{headers:{'content-length':'2048'}})
      : new Response(body);
    const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'token',SCHOOLFOX_MAX_RESPONSE_BYTES:'1024'}), (async () => response) as typeof fetch);
    await assert.rejects(client.messages('classA','pupilA',25,0), SchoolFoxError);
    assert.equal(cancellations,1,`${responseKind} body was not cancelled`);
  }
});

test('login accepts only known normal 2FA state and never exposes identity after failure', async () => {
  for (const user of [
    {...login.user,twoFactorAuthActive:true},
    {...login.user,twoFactorAuthActive:false,twoFactorAuthStatus:'Required'}
  ]) {
    const {client,calls} = fixture({'POST /api/Users/login':{token:'temporary',user}});
    await assert.rejects(client.messages('classA','pupilA',25,0), /two_factor_unsupported/);
    assert.equal(client.status().writeReady,false);
    await assert.rejects(client.messages('classA','pupilA',25,0));
    assert.equal(calls.length,1);
  }
  for (const user of [
    {id:'user1',fullUsername:'Test Parent'},
    {...login.user,twoFactorAuthStatus:'Unknown'},
    {...login.user,twoFactorAuthActive:null}
  ]) {
    const {client,calls} = fixture({'POST /api/Users/login':{token:'temporary',user}});
    await assert.rejects(client.messages('classA','pupilA',25,0), /two_factor_state_unverified/);
    assert.equal(client.status().writeReady,false);
    assert.equal(calls.length,1);
  }
  for (const status of ['Optional','Disabled']) {
    const {client} = fixture({'POST /api/Users/login':{...login,user:{...login.user,twoFactorAuthStatus:status}},'GET /tables/Messages':{results:[],count:0}});
    await client.messages('classA','pupilA',25,0);
    assert.equal(client.status().writeReady,true);
  }
});

test('reply permission follows active message detail and rejects unknown fields', async () => {
  const cases: Array<[Record<string,unknown>,string]> = [
    [{instantMessagesAllowed:false},'reply_unavailable'],
    [{instantMessagesAllowed:undefined},'reply_permission_unverified'],
    [{isOwned:true,instantMessagesCount:0},'reply_unavailable'],
    [{isOwned:true,instantMessagesCount:'1'},'reply_permission_unverified'],
    [{isOwned:undefined},'reply_permission_unverified'],
    [{pupilId:'pupilB'},'pupil_mismatch']
  ];
  const {info: _recipientRecords,...withoutRecipients} = detail;
  for (const message of [detail,withoutRecipients]) {
    for (const [change,code] of cases) {
      const {client,calls} = fixture({'POST /api/Users/login':login,'GET /tables/Messages/msgA':{...message,...change},'GET /tables/InstantMessageGroups':{results:[group],count:1},'POST /tables/InstantMessages':{id:'unexpected'}});
      await assert.rejects(client.reply('msgA','pupilA','groupA','Text'), new RegExp(code));
      assert.equal(calls.some(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages'),false);
    }
  }
  const owned = fixture({'POST /api/Users/login':login,'GET /tables/Messages/msgA':{...detail,isOwned:true,instantMessagesCount:1},'GET /tables/InstantMessageGroups':{results:[group],count:1},'POST /tables/InstantMessages':{id:'reply2'}});
  assert.equal((await owned.client.reply('msgA','pupilA','groupA','Text')).id,'reply2');
  assert.equal(owned.calls.filter(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages').length,1);
});

test('uncertain or malformed write response fails without replay', async () => {
  for (const response of [() => new Response('',{status:500}), () => Response.json({unexpected:true})]) {
    const {client,calls} = fixture({'POST /api/Users/login':login,'GET /tables/Messages/msgA':detail,'GET /tables/InstantMessageGroups':{results:[group],count:1},'POST /tables/InstantMessages':response});
    await assert.rejects(client.reply('msgA','pupilA','groupA','Exact text'), SchoolFoxError);
    assert.equal(calls.filter(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages').length,1);
  }
});

test('remaining read adapters use bounded first-party paths and pupil filters', async () => {
  const routes = {
    'POST /api/Users/login':login,
    'GET /api/Common/Inventory':[{id:'classA',type:'Class'}],
    'GET /tables/InstantMessageGroups':{results:[group],count:1},
    'GET /tables/InstantMessages':{results:[{id:'reply1'}],count:1},
    'GET /tables/Messages':{results:[],count:0},
    'GET /tables/FoxDriveItems':{results:[{id:'itemA'}],count:1},
    'GET /api/FoxDriveItems/classA/Item/itemA':{id:'itemA',schoolClassId:'classA',files:[{id:'fileA'}]}
  };
  const {client,calls} = fixture(routes);
  assert.equal((await client.inventory('schoolA'))[0]?.id,'classA');
  assert.equal((await client.replyGroups('msgA','pupilA',10,5)).results[0]?.id,'groupA');
  assert.equal((await client.replies('groupA','pupilA',10,5)).results[0]?.id,'reply1');
  assert.equal((await client.events('classA','pupilA',10,5)).results.length,0);
  assert.equal((await client.files('classA','pupilA','folderA',10,5)).results[0]?.id,'itemA');
  assert.equal((await client.fileDetail('classA','itemA')).id,'itemA');
  assert.equal(calls[1]?.url.pathname,'/api/Common/Inventory');
  assert.equal(calls[1]?.url.searchParams.get('schoolId'),'schoolA');
  for (const call of calls.filter(x => x.url.pathname.startsWith('/tables/'))) {
    assert.equal(call.url.searchParams.get('$top'),'10');
    assert.equal(call.url.searchParams.get('$skip'),'5');
    assert.match(call.url.searchParams.get('$filter')!, /'pupilA'/);
    if (call.url.pathname === '/tables/Messages' || call.url.pathname === '/tables/FoxDriveItems') {
      assert.match(call.url.searchParams.get('$filter')!, /SchoolClassId eq 'classA'/);
    }
  }
  assert.match(calls.find(x => x.url.pathname === '/tables/Messages')!.url.searchParams.get('$filter')!, /\(\(MessageType eq 'Event' and EndDate ge datetime'2026-10-13T00:00:00Z'\) or DueDate ge datetime'2026-10-13T00:00:00Z'\)/);
  assert.match(calls.find(x => x.url.pathname === '/tables/FoxDriveItems')!.url.searchParams.get('$filter')!, /ParentItemId eq 'folderA'/);
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),[
    'POST /api/Users/login','GET /api/Common/Inventory','GET /tables/InstantMessageGroups','GET /tables/InstantMessages','GET /tables/Messages','GET /tables/FoxDriveItems','GET /api/FoxDriveItems/classA/Item/itemA'
  ]);
});

test('inventory returns every record within the bounded HTTP response', async () => {
  const records = Array.from({length:101},(_,index) => ({id:`class${index}`}));
  const {client} = fixture({'POST /api/Users/login':login,'GET /api/Common/Inventory':records});
  const result = await client.inventory();
  assert.equal(result.length,101);
  assert.equal(result[100]?.id,'class100');
});

test('reply finds a group on the second supported page and sends once', async () => {
  const calls: Captured[] = [];
  const firstPage = Array.from({length:50},(_,index) => ({...group,id:`other${index}`}));
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)); calls.push({url,init});
    if (url.pathname === '/api/Users/login') return Response.json(login);
    if (url.pathname === '/tables/Messages/msgA') return Response.json(detail);
    if (url.pathname === '/tables/InstantMessageGroups') return Response.json({results:url.searchParams.get('$skip') === '0' ? firstPage : [group],count:51});
    if (url.pathname === '/tables/InstantMessages') return Response.json({id:'reply2'});
    throw new Error('unexpected request');
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'test@example.invalid',SCHOOLFOX_PASSWORD:'test-password'}),fetcher as typeof fetch);
  assert.equal((await client.reply('msgA','pupilA','groupA','Text')).id,'reply2');
  const groupCalls = calls.filter(x => x.url.pathname === '/tables/InstantMessageGroups');
  assert.deepEqual(groupCalls.map(x => x.url.searchParams.get('$skip')),['0','50']);
  for (const call of groupCalls) assert.equal(call.url.searchParams.get('$filter'),"MessageId eq 'msgA' and PupilId eq 'pupilA'");
  assert.equal(calls.filter(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages').length,1);
});

test('authenticated 401 clears write readiness', async () => {
  let reads = 0;
  const {client,calls} = fixture({'POST /api/Users/login':login,'GET /tables/Messages':() => ++reads === 1 ? Response.json({results:[],count:0}) : new Response('',{status:401})});
  await client.messages('classA','pupilA',25,0);
  assert.equal(client.status().writeReady,true);
  await assert.rejects(client.messages('classA','pupilA',25,0), /authentication_required/);
  assert.equal(client.status().writeReady,false);
  assert.equal(calls.filter(x => x.url.pathname === '/api/Users/login').length,1);
});

test('failed file write removes only its newly created partial download', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-partial-'));
  const probePath = join(directory,'probe');
  const probe = await open(probePath,'wx');
  const prototype = Object.getPrototypeOf(probe) as {writeFile: typeof probe.writeFile};
  const originalWriteFile = prototype.writeFile;
  await probe.close(); await unlink(probePath);
  try {
    const client = fixture({
      'GET /api/FoxDriveItems/classA/Item/itemA':{id:'itemA',schoolClassId:'classA',files:[{id:'fileA'}]},
      'GET /api/FoxDriveItems/itemA/DownloadFile/fileA':() => new Response('complete content')
    },{SCHOOLFOX_TOKEN:'token',SCHOOLFOX_DOWNLOAD_DIR:directory}).client;
    Reflect.set(prototype,'writeFile',async function(this: typeof probe) {
      await originalWriteFile.call(this,new Uint8Array([42]));
      throw new Error('simulated disk failure');
    });
    await assert.rejects(client.downloadFile('classA','itemA','fileA','partial.txt'), /file_write_failed/);
    await assert.rejects(stat(join(directory,'partial.txt')),{code:'ENOENT'});
  } finally {
    Reflect.set(prototype,'writeFile',originalWriteFile);
    await rm(directory,{recursive:true,force:true});
  }
});

test('normal login derives reply display name from first and last names', async () => {
  const rawLogin = {token:'secret-token',user:{id:'user1',firstName:'  Test ',lastName:' Parent  ',twoFactorAuthActive:false,twoFactorAuthStatus:'Disabled'}};
  const {client,calls} = fixture({
    'POST /api/Users/login':rawLogin,
    'GET /tables/Messages':{results:[],count:0},
    'GET /tables/Messages/msgA':detail,
    'GET /tables/InstantMessageGroups':{results:[group],count:1},
    'POST /tables/InstantMessages':{id:'reply1'},
    'PATCH /tables/MessageRelatedPupils/recipientA':{id:'recipientA'}
  });
  assert.deepEqual(await client.messages('classA','pupilA',25,0),{results:[],count:0});
  assert.equal(client.status().writeReady,true);
  assert.equal((await client.reply('msgA','pupilA','groupA','Exact text')).id,'reply1');
  const post = calls.find(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages');
  assert.equal(JSON.parse(String(post?.init.body)).CreatorFullName,'Test Parent');
  assert.equal((await client.confirm('msgA','pupilA','recipientA')).id,'recipientA');
  const patch = calls.find(x => x.init.method === 'PATCH' && x.url.pathname === '/tables/MessageRelatedPupils/recipientA');
  assert.equal(JSON.parse(String(patch?.init.body)).signedByUserId,'user1');
  assert.equal(calls.filter(x => x.url.pathname === '/api/Users/login').length,1);
});

test('first and last names take precedence as in the SchoolFox app', async () => {
  const user = {...login.user,fullUsername:' Preferred Name ',firstName:'Other',lastName:'Name'};
  const {client,calls} = fixture({
    'POST /api/Users/login':{token:'secret-token',user},
    'GET /tables/Messages/msgA':detail,
    'GET /tables/InstantMessageGroups':{results:[group],count:1},
    'POST /tables/InstantMessages':{id:'reply1'}
  });
  await client.reply('msgA','pupilA','groupA','Text');
  const post = calls.find(x => x.init.method === 'POST' && x.url.pathname === '/tables/InstantMessages');
  assert.equal(JSON.parse(String(post?.init.body)).CreatorFullName,'Other Name');
});

test('valid login with missing name permits reads but blocks both writes before detail GET', async () => {
  const baseUser = {id:'user1',firstName:'Test',lastName:'Parent',twoFactorAuthActive:false,twoFactorAuthStatus:'Disabled'};
  const users = [
    {...baseUser,firstName:'',lastName:'Parent'},
    {...baseUser,firstName:'Test',lastName:undefined}
  ];
  for (const user of users) {
    const {client,calls} = fixture({'POST /api/Users/login':{token:'secret-token',user},'GET /tables/Messages':{results:[],count:0}});
    assert.deepEqual(await client.messages('classA','pupilA',25,0),{results:[],count:0});
    assert.equal(client.status().writeReady,false);
    await assert.rejects(client.reply('msgA','pupilA','groupA','Text'),/login_identity_required/);
    await assert.rejects(client.confirm('msgA','pupilA','recipientA'),/login_identity_required/);
    assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['POST /api/Users/login','GET /tables/Messages']);
  }
});

test('login without a valid user ID fails before read or write requests', async () => {
  for (const id of [undefined,'invalid id']) {
    const {client,calls} = fixture({'POST /api/Users/login':{token:'secret-token',user:{...login.user,id}}});
    await assert.rejects(client.messages('classA','pupilA',25,0),/unexpected_response/);
    assert.equal(client.status().writeReady,false);
    await assert.rejects(client.reply('msgA','pupilA','groupA','Text'),/unexpected_response/);
    await assert.rejects(client.confirm('msgA','pupilA','recipientA'),/unexpected_response/);
    assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['POST /api/Users/login']);
  }
});

test('unknown 2FA state still rejects token before read', async () => {
  const {client,calls} = fixture({'POST /api/Users/login':{token:'secret-token',user:{id:'user1',firstName:'Test',lastName:'Parent',twoFactorAuthActive:false,twoFactorAuthStatus:'Unknown'}}});
  await assert.rejects(client.messages('classA','pupilA',25,0),/two_factor_state_unverified/);
  assert.equal(client.status().writeReady,false);
  assert.equal(calls.length,1);
});
