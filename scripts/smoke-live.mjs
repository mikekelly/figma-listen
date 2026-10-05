// Opt-in authentication + MCP startup check. Does not read files or comments or write to Figma.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

if (!process.env.FIGMA_ACCESS_TOKEN) throw new Error('Export FIGMA_ACCESS_TOKEN first');
const clients = [1, 2].map(id => new Client({ name: `figma-listen-smoke-${id}`, version: '1' }));
try {
  await Promise.all(clients.map(client => client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: { FIGMA_ACCESS_TOKEN: process.env.FIGMA_ACCESS_TOKEN }, stderr: 'pipe' }))));
  const statuses = await Promise.all(clients.map(async client => {
    const result = await client.callTool({ name: 'listen_status', arguments: {} });
    assert.ok(!result.isError);
    const status = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(status.state_storage, 'memory');
    assert.equal(status.active_subscriptions, 0);
    return status;
  }));
  console.log(JSON.stringify({ authenticated: true, parallel_processes: statuses.length,
    storage: statuses.map(status => status.state_storage) }, null, 2));
} finally { await Promise.all(clients.map(client => client.close())); }
