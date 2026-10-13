import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

test('typed tools and safe tool errors over SDK transport', async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const school = new SchoolFoxClient(loadConfig({}));
  const server = createServer(school);
  const client = new Client({ name:'test-client', version:'1.0.0' });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length,14);
    assert.ok(tools.every(x => x.inputSchema && x.inputSchema.type === 'object'));
    assert.equal(tools.find(x => x.name === 'schoolfox_message_detail')?.annotations?.readOnlyHint,false);
    assert.equal(tools.find(x => x.name === 'schoolfox_reply')?.annotations?.idempotentHint,false);
    assert.equal(tools.find(x => x.name === 'schoolfox_message_attachments')?.annotations?.readOnlyHint,true);
    assert.equal(tools.find(x => x.name === 'schoolfox_download_message_attachment')?.annotations?.readOnlyHint,false);
    assert.equal(tools.find(x => x.name === 'schoolfox_download_message_attachment')?.annotations?.destructiveHint,false);
    const status = await client.callTool({ name:'schoolfox_status', arguments:{} });
    assert.equal(status.isError,undefined);
    assert.equal((status.structuredContent as Record<string,unknown>).configured,false);
    const missing = await client.callTool({ name:'schoolfox_messages', arguments:{ classId:'classA', pupilId:'pupilA' } });
    assert.equal(missing.isError,true);
    assert.deepEqual(JSON.parse((missing.content[0] as {text:string}).text), { operation:'messages',code:'credentials_required' });
    const invalid = await client.callTool({ name:'schoolfox_reply', arguments:{ messageId:'bad\'id',pupilId:'pupilA',groupId:'groupA',text:'x' } });
    assert.equal(invalid.isError,true);
    const noAttachments = await client.callTool({ name:'schoolfox_message_attachments', arguments:{ messageId:'msgA' } });
    assert.equal(noAttachments.isError,true);
    assert.equal(JSON.parse((noAttachments.content[0] as {text:string}).text).code,'credentials_required');
  } finally { await client.close(); await server.close(); }
});

test('message detail without recipient records succeeds over MCP transport', async () => {
  const [serverTransport,clientTransport] = InMemoryTransport.createLinkedPair();
  const message = {id:'msgA',pupilId:'pupilA',schoolClassId:'classA',content:'Fixture content',isRead:false};
  const calls: string[] = [];
  const school = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'fixture-token'}),(async (input,init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    assert.equal(init?.method,'GET');
    assert.equal(url.pathname,'/tables/Messages/msgA');
    return Response.json(message);
  }) as typeof fetch);
  const server = createServer(school);
  const client = new Client({name:'detail-tool-test',version:'1.0.0'});
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({name:'schoolfox_message_detail',arguments:{messageId:'msgA'}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(result.structuredContent,message);
    assert.deepEqual(calls,['GET /tables/Messages/msgA']);
  } finally { await client.close(); await server.close(); }
});

test('message attachment tools list and save a native filename over MCP transport', async () => {
  const directory = await mkdtemp(join(tmpdir(),'schoolfox-mcp-attachments-'));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const calls: URL[] = [];
  const attachmentName = 'Elternbrief März + Info.pdf';
  const bytes = '%PDF-1.7\nfixture';
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.method,'GET');
    assert.equal(url.origin,'https://api.schoolfox.com');
    assert.equal(url.pathname,'/api/Files/Messages/msgA');
    if (!url.searchParams.has('fileName')) return Response.json([{name:attachmentName,size:Buffer.byteLength(bytes)}]);
    assert.equal(url.searchParams.get('fileName'),attachmentName);
    return new Response(bytes,{headers:{'content-type':'application/pdf'}});
  };
  const school = new SchoolFoxClient(loadConfig({SCHOOLFOX_TOKEN:'fixture-token',SCHOOLFOX_DOWNLOAD_DIR:directory}),fetcher as typeof fetch);
  const server = createServer(school);
  const client = new Client({name:'attachment-tool-test',version:'1.0.0'});
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const listed = await client.callTool({name:'schoolfox_message_attachments',arguments:{messageId:'msgA'}});
    assert.equal(listed.isError,undefined);
    assert.deepEqual(listed.structuredContent,{messageId:'msgA',attachments:[{name:attachmentName,size:Buffer.byteLength(bytes)}]});
    const downloaded = await client.callTool({name:'schoolfox_download_message_attachment',arguments:{messageId:'msgA',attachmentName}});
    assert.equal(downloaded.isError,undefined);
    const result = downloaded.structuredContent as {path:string;bytes:number;contentType:string};
    assert.equal(result.path,join(directory,attachmentName));
    assert.equal(result.bytes,Buffer.byteLength(bytes));
    assert.equal(result.contentType,'application/pdf');
    assert.equal(await readFile(result.path,'utf8'),bytes);
    const invalid = await client.callTool({name:'schoolfox_download_message_attachment',arguments:{messageId:'msgA'}});
    assert.equal(invalid.isError,true);
    assert.equal(calls.length,3);
  } finally { await client.close(); await server.close(); await rm(directory,{recursive:true,force:true}); }
});
