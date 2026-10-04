// Opt-in authentication + MCP startup check. Does not read files or comments or write to Figma.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

if (!process.env.FIGMA_ACCESS_TOKEN) throw new Error('Export FIGMA_ACCESS_TOKEN first');
const directory = await mkdtemp(join(tmpdir(), 'figma-listen-live-'));
const client = new Client({ name: 'figma-listen-smoke', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--state-dir', directory],
  env: { FIGMA_ACCESS_TOKEN: process.env.FIGMA_ACCESS_TOKEN }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const status = await client.callTool({ name: 'listen_status', arguments: {} });
  if (status.isError) throw new Error('Status call failed');
  console.log(JSON.stringify({ authenticated: true, tools: tools.tools.map(tool => tool.name),
    status: status.structuredContent ?? JSON.parse(status.content[0].text) }, null, 2));
} finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
