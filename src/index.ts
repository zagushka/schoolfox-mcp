import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SchoolFoxClient } from './client.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const server = createServer(new SchoolFoxClient(loadConfig()));
await server.connect(new StdioServerTransport());
process.stderr.write('SchoolFox MCP preview ready\n');
