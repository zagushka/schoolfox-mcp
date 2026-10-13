import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { SchoolFoxError } from '../src/contracts.js';

type Call = { url: URL; init: RequestInit };
const name = 'Plan + Märchen.pdf';
const metadata = [{name,size:12}];
function makeClient(respond: (url: URL, init: RequestInit, calls: Call[]) => Response | Promise<Response>, directory: string, options: Record<string,string> = {}) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({url,init});
    return respond(url,init,calls);
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'private-token',SCHOOLFOX_DOWNLOAD_DIR:directory,...options}),fetcher as typeof fetch);
  return {client,calls};
}
const metadataResponse = (url: URL) => {
  assert.equal(url.origin,'https://api.schoolfox.com');
  assert.equal(url.pathname,'/api/Files/Messages/msgA');
  return Response.json(metadata);
};

test('lists only exact names and sizes without message detail or receipt requests', async () => {
  const {client,calls} = makeClient(url => metadataResponse(url),tmpdir());
  assert.deepEqual(await client.messageAttachments('msgA'),{messageId:'msgA',attachments:metadata});
  assert.deepEqual(calls.map(x => `${x.init.method} ${x.url.pathname}`),['GET /api/Files/Messages/msgA']);
  assert.equal((calls[0]!.init.headers as Record<string,string>)['X-ZUMO-AUTH'],'private-token');
  const empty = makeClient(() => Response.json([]),tmpdir());
  assert.deepEqual(await empty.client.messageAttachments('msgA'),{messageId:'msgA',attachments:[]});
});

test('rejects malformed metadata, empty names, invalid sizes, and ambiguous fresh selection', async () => {
  for (const bad of [{files:metadata},[{name:'',size:1}],[{name:'file',size:-1}],[{name:'file',size:1.5}],[{name:'file'}]]) {
    const {client} = makeClient(() => Response.json(bad),tmpdir());
    await assert.rejects(client.messageAttachments('msgA'),/unexpected_response/);
  }
  const {client,calls} = makeClient(() => Response.json([metadata[0],metadata[0]]),tmpdir());
  await assert.rejects(client.downloadMessageAttachment('msgA',name),/attachment_not_unique/);
  assert.equal(calls.length,1);
  let metadataReads = 0;
  const changed = makeClient(() => Response.json(++metadataReads === 1 ? metadata : []),tmpdir());
  await changed.client.messageAttachments('msgA');
  await assert.rejects(changed.client.downloadMessageAttachment('msgA',name),/attachment_not_unique/);
  assert.equal(changed.calls.length,2);
});

test('direct download preserves native selected name and supports a Unicode local name', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-attachment-'));
  try {
    const {client,calls} = makeClient((url,_init,calls) => calls.length === 1 ? metadataResponse(url) : new Response('pdf content!',{headers:{'content-type':'application/pdf'}}),directory);
    const result = await client.downloadMessageAttachment('msgA',name,'Задание final.pdf');
    assert.deepEqual(result,{path:join(directory,'Задание final.pdf'),bytes:12,contentType:'application/pdf'});
    assert.equal(await readFile(result.path,'utf8'),'pdf content!');
    assert.equal(calls[1]!.url.pathname,'/api/Files/Messages/msgA');
    assert.equal(calls[1]!.url.searchParams.get('fileName'),name);
    assert.match(calls[1]!.url.search,/fileName=Plan\+%2B\+M%C3%A4rchen.pdf/);
    assert.equal(calls[1]!.init.redirect,'manual');
    assert.equal((calls[1]!.init.headers as Record<string,string>)['X-ZUMO-AUTH'],'private-token');
    assert.deepEqual(calls.map(x => x.init.method),['GET','GET']);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('accepts one approved signed redirect without forwarding API credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-redirect-'));
  try {
    const signed = 'https://getfile.foxeducation.com/opaque?signature=private-signed-value';
    const {client,calls} = makeClient((url,_init,calls) => {
      if (calls.length === 1) return metadataResponse(url);
      if (calls.length === 2) return new Response(null,{status:302,headers:{location:signed}});
      return new Response('downloaded!!',{headers:{'content-type':'application/pdf'}});
    },directory);
    const result = await client.downloadMessageAttachment('msgA',name);
    assert.deepEqual(result,{path:join(directory,name),bytes:12,contentType:'application/pdf'});
    assert.equal(await readFile(result.path,'utf8'),'downloaded!!');
    assert.equal(calls[2]!.url.href,signed);
    assert.equal(calls[2]!.init.redirect,'manual');
    assert.equal(calls[2]!.init.credentials,'omit');
    assert.equal(calls[2]!.init.referrerPolicy,'no-referrer');
    assert.equal(calls[2]!.init.headers,undefined);
    assert.ok(!JSON.stringify(result).includes('private-signed-value'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('rejects other redirects and hides signed locations from errors', async () => {
  const locations = [
    'http://getfile.foxeducation.com/file?secret=abc',
    'https://other.example/file?secret=abc',
    'https://user:pass@getfile.foxeducation.com/file?secret=abc',
    'https://getfile.foxeducation.com:8443/file?secret=abc',
    '/relative/file?secret=abc',
    ''
  ];
  for (const location of locations) {
    const {client,calls} = makeClient((url,_init,calls) => calls.length === 1 ? metadataResponse(url) : new Response(null,{status:302,headers:location ? {location} : undefined}),tmpdir());
    await assert.rejects(client.downloadMessageAttachment('msgA',name),(error: unknown) => error instanceof SchoolFoxError && error.code === 'redirect_rejected' && !error.message.includes('secret='));
    assert.equal(calls.length,2);
  }
  const second = makeClient((url,_init,calls) => calls.length === 1 ? metadataResponse(url) : new Response(null,{status:302,headers:{location:'https://getfile.foxeducation.com/secret'}}),tmpdir());
  await assert.rejects(second.client.downloadMessageAttachment('msgA',name),/redirect_rejected/);
  assert.equal(second.calls.length,3);
  const wrongStatus = makeClient((url,_init,calls) => calls.length === 1 ? metadataResponse(url) : new Response(null,{status:301,headers:{location:'https://getfile.foxeducation.com/secret'}}),tmpdir());
  await assert.rejects(wrongStatus.client.downloadMessageAttachment('msgA',name),/redirect_rejected/);
  assert.equal(wrongStatus.calls.length,2);
});

test('rejects unsafe native and local filenames before downloading', async () => {
  for (const unsafe of ['', '.', '..', 'a/b.pdf', 'a\\b.pdf', 'bad\u0000.pdf', 'bad\n.pdf', 'é'.repeat(128)]) {
    const {client,calls} = makeClient(() => Response.json(metadata),tmpdir());
    await assert.rejects(client.downloadMessageAttachment('msgA',unsafe),/unsafe_filename/);
    assert.equal(calls.length,0);
    await assert.rejects(client.downloadMessageAttachment('msgA',name,unsafe),/unsafe_filename/);
    assert.equal(calls.length,0);
  }
});

test('rejects header and streamed oversize bodies and cancels unfinished streams', async () => {
  for (const kind of ['header','stream'] as const) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (kind === 'stream') controller.enqueue(new Uint8Array(1025)); },
      cancel() { cancelled++; }
    });
    const {client} = makeClient((url,_init,calls) => calls.length === 1 ? metadataResponse(url) : new Response(body,kind === 'header' ? {headers:{'content-length':'1025'}} : {}),tmpdir(),{SCHOOLFOX_MAX_DOWNLOAD_BYTES:'1024'});
    await assert.rejects(client.downloadMessageAttachment('msgA',name),/response_too_large/);
    assert.equal(cancelled,1);
  }
});

test('one timeout budget covers the API download and signed-host fetch', async () => {
  const signals: AbortSignal[] = [];
  const {client,calls} = makeClient(async (url,init,calls) => {
    if (calls.length === 1) return metadataResponse(url);
    signals.push(init.signal as AbortSignal);
    if (calls.length === 2) {
      await new Promise(resolve => setTimeout(resolve,10));
      return new Response(null,{status:302,headers:{location:'https://getfile.foxeducation.com/secret'}});
    }
    return new Promise<Response>((_resolve,reject) => init.signal?.addEventListener('abort',() => reject(new Error('aborted'))));
  },tmpdir());
  // The configuration loader enforces a 1-second minimum; a smaller injected budget keeps this synthetic test fast.
  (client as unknown as {config:{timeoutMs:number}}).config.timeoutMs = 30;
  await assert.rejects(client.downloadMessageAttachment('msgA',name),/timeout/);
  assert.equal(calls.length,3);
  assert.equal(signals[0],signals[1]);
});

test('refuses overwrites and symlinks, then cleans a newly created partial file on write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-output-'));
  const outside = join(directory,'outside.txt');
  const probePath = join(directory,'probe');
  const probe = await open(probePath,'wx');
  const prototype = Object.getPrototypeOf(probe) as {writeFile:typeof probe.writeFile};
  const originalWriteFile = prototype.writeFile;
  await probe.close(); await unlink(probePath);
  try {
    await writeFile(join(directory,'existing.pdf'),'original');
    await writeFile(outside,'outside');
    await symlink(outside,join(directory,'link.pdf'));
    const {client} = makeClient(url => url.searchParams.has('fileName') ? new Response('new content!') : metadataResponse(url),directory);
    await assert.rejects(client.downloadMessageAttachment('msgA',name,'existing.pdf'),/file_exists_or_unwritable/);
    assert.equal(await readFile(join(directory,'existing.pdf'),'utf8'),'original');
    await assert.rejects(client.downloadMessageAttachment('msgA',name,'link.pdf'),/file_exists_or_unwritable/);
    assert.equal(await readFile(outside,'utf8'),'outside');
    Reflect.set(prototype,'writeFile',async function(this: typeof probe) {
      await originalWriteFile.call(this,new Uint8Array([42]));
      throw new Error('simulated disk failure');
    });
    await assert.rejects(client.downloadMessageAttachment('msgA',name,'partial.pdf'),/file_write_failed/);
    await assert.rejects(stat(join(directory,'partial.pdf')),{code:'ENOENT'});
  } finally {
    Reflect.set(prototype,'writeFile',originalWriteFile);
    await rm(directory,{recursive:true,force:true});
  }
});

test('metadata size rejects before binary GET and received size must match before file creation', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-size-'));
  try {
    const tooLarge = makeClient(() => Response.json([{name,size:1025}]),directory,{SCHOOLFOX_MAX_DOWNLOAD_BYTES:'1024'});
    await assert.rejects(tooLarge.client.downloadMessageAttachment('msgA',name),/response_too_large/);
    assert.equal(tooLarge.calls.length,1);
    const mismatch = makeClient(url => url.searchParams.has('fileName') ? new Response('short') : metadataResponse(url),directory);
    await assert.rejects(mismatch.client.downloadMessageAttachment('msgA',name),/attachment_size_mismatch/);
    assert.equal(mismatch.calls.length,2);
    await assert.rejects(stat(join(directory,name)),{code:'ENOENT'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('only status 200 can be saved and rejected 206 body is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-status-'));
  try {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial body')); },
      cancel() { cancelled++; }
    });
    const partial = makeClient(url => url.searchParams.has('fileName') ? new Response(body,{status:206}) : metadataResponse(url),directory);
    await assert.rejects(partial.client.downloadMessageAttachment('msgA',name),(error:unknown) => error instanceof SchoolFoxError && error.code === 'unexpected_response' && error.status === 206);
    assert.equal(cancelled,1);
    await assert.rejects(stat(join(directory,name)),{code:'ENOENT'});
    const empty = makeClient(url => url.searchParams.has('fileName') ? new Response(null,{status:204}) : metadataResponse(url),directory);
    await assert.rejects(empty.client.downloadMessageAttachment('msgA',name),(error:unknown) => error instanceof SchoolFoxError && error.code === 'unexpected_response' && error.status === 204);
    await assert.rejects(stat(join(directory,name)),{code:'ENOENT'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('file-host 401 keeps validated API identity and never forwards credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-filehost401-'));
  const calls: Call[] = [];
  const login = {token:'private-login-token',user:{id:'user1',firstName:'Test',lastName:'Parent',twoFactorAuthActive:false,twoFactorAuthStatus:'Disabled'}};
  const fetcher = async (input:string|URL|Request,init:RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)); calls.push({url,init});
    if (url.pathname === '/api/Users/login') return Response.json(login);
    if (url.pathname === '/api/Files/Messages/msgA' && !url.searchParams.has('fileName')) return Response.json(metadata);
    if (url.origin === 'https://api.schoolfox.com') return new Response(null,{status:302,headers:{location:'https://getfile.foxeducation.com/signed?secret=private-value'}});
    return new Response(null,{status:401});
  };
  try {
    const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'test@example.invalid',SCHOOLFOX_PASSWORD:'dummy-password',SCHOOLFOX_DOWNLOAD_DIR:directory}),fetcher as typeof fetch);
    assert.deepEqual(await client.messageAttachments('msgA'),{messageId:'msgA',attachments:metadata});
    assert.equal(client.status().writeReady,true);
    await assert.rejects(client.downloadMessageAttachment('msgA',name),(error:unknown) => error instanceof SchoolFoxError && error.code === 'http_error' && error.status === 401 && !error.message.includes('private-value'));
    assert.equal(client.status().writeReady,true);
    assert.equal(calls.filter(x => x.url.pathname === '/api/Users/login').length,1);
    const fileHost = calls.find(x => x.url.origin === 'https://getfile.foxeducation.com');
    assert.ok(fileHost);
    assert.equal(fileHost.init.headers,undefined);
    assert.equal(fileHost.init.credentials,'omit');
    assert.equal(fileHost.init.redirect,'manual');
    await assert.rejects(stat(join(directory,name)),{code:'ENOENT'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('API download 401 clears validated identity', async () => {
  const login = {token:'private-login-token',user:{id:'user1',firstName:'Test',lastName:'Parent',twoFactorAuthActive:false,twoFactorAuthStatus:'Disabled'}};
  const calls: Call[] = [];
  const fetcher = async (input:string|URL|Request,init:RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)); calls.push({url,init});
    if (url.pathname === '/api/Users/login') return Response.json(login);
    if (!url.searchParams.has('fileName')) return Response.json(metadata);
    return new Response(null,{status:401});
  };
  const client = new SchoolFoxClient(loadConfig({SCHOOLFOX_EMAIL:'test@example.invalid',SCHOOLFOX_PASSWORD:'dummy-password'}),fetcher as typeof fetch);
  await client.messageAttachments('msgA');
  assert.equal(client.status().writeReady,true);
  await assert.rejects(client.downloadMessageAttachment('msgA',name),(error:unknown) => error instanceof SchoolFoxError && error.code === 'authentication_required' && error.status === 401);
  assert.equal(client.status().writeReady,false);
  assert.equal(calls.length,7);
});
