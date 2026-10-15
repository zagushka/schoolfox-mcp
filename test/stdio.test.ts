import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

test('built server initializes, lists tools, calls status, and closes via stdio', async () => {
  const transport = new StdioClientTransport({ command:process.execPath, args:[resolve('dist/src/index.js')], env:{...process.env, SCHOOLFOX_TOKEN:'', SCHOOLFOX_EMAIL:'', SCHOOLFOX_PASSWORD:''}, stderr:'pipe' });
  const client = new Client({ name:'stdio-test',version:'1.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length,38);
    for (const name of ['schoolfox_absences','schoolfox_absence_detail','schoolfox_absence_options','schoolfox_report_absence','schoolfox_edit_absence']) {
      assert.ok(tools.some(x => x.name === name),`${name} is registered in the built server`);
    }
    assert.ok(tools.some(x => x.name === 'schoolfox_status'));
    assert.ok(tools.some(x => x.name === 'schoolfox_message_attachments'));
    assert.ok(tools.some(x => x.name === 'schoolfox_download_message_attachment'));
    assert.ok(tools.some(x => x.name === 'schoolfox_chat_history'));
    assert.ok(tools.some(x => x.name === 'schoolfox_consultation_slots'));
    assert.ok(tools.some(x => x.name === 'schoolfox_timetable'));
    assert.ok(tools.some(x => x.name === 'schoolfox_activity_feed'));
    assert.ok(tools.some(x => x.name === 'schoolfox_authenticate'));
    const status = await client.callTool({name:'schoolfox_status',arguments:{}});
    assert.equal((status.structuredContent as Record<string,unknown>).configured,false);
  } finally { await client.close(); }
});
