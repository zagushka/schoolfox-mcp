import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SchoolFoxTransport } from './transport.js';
import { SchoolFoxError } from './contracts.js';

const safe = async (fn: () => Promise<unknown>) => {
  try {
    const value = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(error instanceof SchoolFoxError ? error.toJSON() : { operation: 'auth', code: 'invalid_input_or_internal_error' }) }], isError: true };
  }
};

export function registerAuthTools(server: McpServer, transport: SchoolFoxTransport): void {
  server.registerTool('schoolfox_authenticate', {
    description: 'Start login or complete an existing two-factor challenge with the exact code. The code and temporary token stay in memory; this does not change two-factor settings.',
    inputSchema: z.object({ code: z.string().min(1).max(128).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, ({ code }) => safe(() => transport.authenticate(code)));
  server.registerTool('schoolfox_renew_session', {
    description: 'Renew the current SchoolFox session, or log in if no session exists. This can invalidate an old login session but sends no message or booking.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, () => safe(() => transport.renewSession()));
}
