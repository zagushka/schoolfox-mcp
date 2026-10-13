import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const user = { id: 'userA', fullUsername: 'Test Parent', twoFactorAuthActive: false, twoFactorAuthStatus: 'Optional' };
const list = { results: [], count: 0 };

test('concurrent expired reads share one renewal and each GET retries once', async () => {
  const calls: Array<{ path: string; token?: string }> = [];
  let resolveRenew!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveRenew = resolve; });
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const token = (init?.headers as Record<string,string>)?.['X-ZUMO-AUTH'];
    calls.push({ path, token });
    if (path === '/api/Users/login/token') return pending;
    if (token === 'old') return new Response(null, { status: 401 });
    return Response.json(list);
  };
  const client = new SchoolFoxClient(loadConfig({ SCHOOLFOX_TOKEN: 'old' }), fetcher as typeof fetch);
  const a = client.messages('classA','pupilA',25,0);
  const b = client.messages('classA','pupilB',25,0);
  await new Promise(resolve => setImmediate(resolve));
  resolveRenew(Response.json({ token: 'new', user }));
  assert.deepEqual(await Promise.all([a,b]), [list,list]);
  assert.equal(calls.filter(x => x.path === '/api/Users/login/token').length, 1);
  assert.equal(calls.filter(x => x.path === '/tables/Messages' && x.token === 'old').length, 2);
  assert.equal(calls.filter(x => x.path === '/tables/Messages' && x.token === 'new').length, 2);
});

test('failed renewal falls back to credentials and a failed write never replays', async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === '/api/Users/login/token') return new Response(null, { status: 401 });
    if (path === '/api/Users/login') return Response.json({ token: 'fresh', user });
    if (path === '/tables/Messages') return calls.includes('POST /api/Users/login') ? Response.json(list) : new Response(null, { status: 401 });
    return new Response(null, { status: 401 });
  };
  const client = new SchoolFoxClient(loadConfig({ SCHOOLFOX_TOKEN:'stale', SCHOOLFOX_EMAIL:'parent@example.invalid', SCHOOLFOX_PASSWORD:'password' }), fetcher as typeof fetch);
  assert.deepEqual(await client.messages('classA','pupilA',25,0), list);
  assert.equal(calls.filter(x => x === 'POST /api/Users/login').length,1);
  await assert.rejects(client.request('synthetic_write','POST','tables/InstantMessages',{Content:'fixture'}),/authentication_required/);
  assert.equal(calls.filter(x => x === 'POST /tables/InstantMessages').length,1);
});

test('a read arriving during fallback login shares the recovery login', async () => {
  let finishLogin!: (response: Response) => void;
  let loginStarted!: () => void;
  const pendingLogin = new Promise<Response>(resolve => { finishLogin = resolve; });
  const started = new Promise<void>(resolve => { loginStarted = resolve; });
  const calls: Array<{ path: string; token?: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const token = (init?.headers as Record<string,string>)?.['X-ZUMO-AUTH'];
    calls.push({ path, token });
    if (path === '/api/Users/login/token') return new Response(null,{status:401});
    if (path === '/api/Users/login') { loginStarted(); return pendingLogin; }
    return token === 'old' ? new Response(null,{status:401}) : Response.json(list);
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'old',SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  const first = client.messages('classA','pupilA',25,0);
  await started;
  const second = client.messages('classA','pupilB',25,0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.path === '/api/Users/login').length,1);
  assert.equal(calls.filter(call => call.path === '/tables/Messages').length,1);
  finishLogin(Response.json({token:'fresh',user}));
  assert.deepEqual(await Promise.all([first,second]),[list,list]);
  assert.equal(calls.filter(call => call.path === '/api/Users/login').length,1);
  assert.equal(calls.filter(call => call.path === '/tables/Messages' && call.token === 'fresh').length,2);
});

test('late old-token 401 waits for explicit login and uses its new session', async () => {
  let finishOldRead!: (response: Response) => void;
  let finishLogin!: (response: Response) => void;
  let loginStarted!: () => void;
  const oldRead = new Promise<Response>(resolve => { finishOldRead = resolve; });
  const pendingLogin = new Promise<Response>(resolve => { finishLogin = resolve; });
  const started = new Promise<void>(resolve => { loginStarted = resolve; });
  const calls: Array<{ path: string; token?: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const token = (init?.headers as Record<string,string>)?.['X-ZUMO-AUTH'];
    calls.push({ path, token });
    if (path === '/api/Users/login') { loginStarted(); return pendingLogin; }
    if (path === '/api/Users/login/token') return Response.json({token:'wrong-renewal',user});
    return token === 'old' ? oldRead : Response.json(list);
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'old',SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  const read = client.messages('classA','pupilA',25,0);
  await new Promise(resolve => setImmediate(resolve));
  const explicit = client.authenticate();
  await started;
  finishOldRead(new Response(null,{status:401}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.path === '/api/Users/login/token').length,0);
  finishLogin(Response.json({token:'explicit-new',user}));
  assert.equal((await explicit).authentication,'ready');
  assert.deepEqual(await read,list);
  assert.equal(calls.filter(call => call.path === '/api/Users/login/token').length,0);
  assert.equal([...calls].reverse().find(call => call.path === '/tables/Messages')?.token,'explicit-new');
});

test('2FA challenge completes with temporary token and exposes no secret over SDK', async () => {
  const calls: Array<{ path:string; token?:string; body?:string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({path, token:(init?.headers as Record<string,string>)?.['X-ZUMO-AUTH'], body:String(init?.body ?? '')});
    if (path === '/api/Users/login') return Response.json({token:'temporary-secret',user:{...user,twoFactorAuthActive:true}});
    if (path === '/api/2fa/login') return Response.json({token:'final-secret',user:{...user,twoFactorAuthActive:true}});
    return Response.json(list);
  };
  const school = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  const [serverSide,clientSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(school); const sdk = new Client({name:'auth-test',version:'1.0.0'});
  try {
    await server.connect(serverSide); await sdk.connect(clientSide);
    const start = await sdk.callTool({name:'schoolfox_authenticate',arguments:{}});
    assert.equal(start.isError,undefined);
    assert.equal((start.structuredContent as Record<string,unknown>).authentication,'two_factor_required');
    const completed = await sdk.callTool({name:'schoolfox_authenticate',arguments:{code:'123 456'}});
    assert.equal(completed.isError,undefined);
    assert.equal((completed.structuredContent as Record<string,unknown>).writeReady,true);
    await school.messages('classA','pupilA',25,0);
    assert.equal(calls.find(x => x.path === '/api/2fa/login')?.token,'temporary-secret');
    assert.equal(calls.find(x => x.path === '/tables/Messages')?.token,'final-secret');
    assert.ok(!JSON.stringify(start).includes('temporary-secret'));
    assert.ok(!JSON.stringify(completed).includes('123 456'));
    assert.ok(!JSON.stringify(completed).includes('final-secret'));
  } finally { await sdk.close(); await server.close(); }
});

test('2FA code without challenge and setup-required state fail safely', async () => {
  let calls = 0;
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}), (async () => {
    calls++;
    return Response.json({token:'temporary-secret',user:{...user,twoFactorAuthStatus:'Required'}});
  }) as typeof fetch);
  await assert.rejects(client.authenticate('code'),/two_factor_challenge_required/);
  assert.equal(calls,0);
  assert.deepEqual((await client.authenticate()).authentication,'two_factor_setup_required');
  await assert.rejects(client.messages('classA','pupilA',25,0),/two_factor_setup_required/);
  assert.equal(calls,1);
});

test('invalid 2FA code remains explicit and a later correct code can complete the challenge', async () => {
  const tokens: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/Users/login') return Response.json({token:'temporary-secret',user:{...user,twoFactorAuthActive:true}});
    tokens.push((init?.headers as Record<string,string>)['X-ZUMO-AUTH']);
    return JSON.parse(String(init?.body)).password === 'good'
      ? Response.json({token:'final-secret',user:{...user,twoFactorAuthActive:true}})
      : new Response(null,{status:401});
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  assert.equal((await client.authenticate()).authentication,'two_factor_required');
  await assert.rejects(client.authenticate('bad'),/invalid_code/);
  assert.equal(client.status().authentication,'two_factor_required');
  assert.equal((await client.authenticate('good')).authentication,'ready');
  assert.deepEqual(tokens,['temporary-secret','temporary-secret']);
});

test('explicit login restarts setup-required and replaces a pending challenge', async () => {
  let logins = 0;
  const codeTokens: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/Users/login') {
      logins++;
      if (logins === 1) return Response.json({token:'setup-token',user:{...user,twoFactorAuthStatus:'Required'}});
      return Response.json({token:`challenge-${logins}`,user:{...user,twoFactorAuthActive:true}});
    }
    if (path === '/api/2fa/login') {
      codeTokens.push((init?.headers as Record<string,string>)['X-ZUMO-AUTH']);
      return Response.json({token:'final-token',user:{...user,twoFactorAuthActive:true}});
    }
    return Response.json(list);
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  assert.equal((await client.authenticate()).authentication,'two_factor_setup_required');
  await assert.rejects(client.messages('classA','pupilA',25,0),/two_factor_setup_required/);
  assert.equal((await client.authenticate()).authentication,'two_factor_required');
  assert.equal((await client.authenticate()).authentication,'two_factor_required');
  assert.equal((await client.authenticate('code')).authentication,'ready');
  assert.equal(logins,3);
  assert.deepEqual(codeTokens,['challenge-3']);
});

test('second 401 after one recovery clears write readiness without another retry', async () => {
  let renewals = 0;
  let reads = 0;
  const fetcher = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/Users/login') return Response.json({token:'old',user});
    if (path === '/api/Users/login/token') { renewals++; return Response.json({token:'new',user}); }
    reads++;
    return new Response(null,{status:401});
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'parent@example.invalid',SCHOOLFOX_PASSWORD:'password'}),fetcher as typeof fetch);
  await client.authenticate();
  assert.equal(client.status().writeReady,true);
  await assert.rejects(client.messages('classA','pupilA',25,0),/authentication_required/);
  assert.equal(client.status().writeReady,false);
  assert.equal(renewals,1);
  assert.equal(reads,2);
});

test('late old-token download 401 reuses already recovered session', async () => {
  let resolveLate!: (response: Response) => void;
  const late = new Promise<Response>(resolve => { resolveLate = resolve; });
  let oldCalls = 0; let renewals = 0; let goodCalls = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/Users/login/token') { renewals++; return Response.json({token:'fresh',user}); }
    if (path !== '/api/Files/Messages/msgA') throw new Error('unexpected path');
    const token = (init?.headers as Record<string,string>)['X-ZUMO-AUTH'];
    if (token === 'old') return ++oldCalls === 1 ? late : new Response(null,{status:401});
    goodCalls++;
    return new Response('x');
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'old'}),fetcher as typeof fetch);
  const first = client.downloadSigned('fixture','api/Files/Messages/msgA?fileName=x',1);
  const second = client.downloadSigned('fixture','api/Files/Messages/msgA?fileName=x',1);
  await second;
  resolveLate(new Response(null,{status:401}));
  await first;
  assert.equal(renewals,1);
  assert.equal(goodCalls,2);
});

test('binary transport rejects partial HTTP responses', async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
    cancel() { cancelled++; }
  });
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'token'}), (async () => new Response(body,{status:206})) as typeof fetch);
  await assert.rejects(client.request('binary','GET','api/FoxDriveItems/itemA/DownloadFile/fileA',undefined,true,true),/unexpected_response/);
  assert.equal(cancelled,1);
});
