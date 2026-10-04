#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { authenticate, credentialEntry, loadToken } from './auth.js';
import { FigmaClient } from './figma.js';
import { StateStore } from './store.js';
import { ListenEngine } from './engine.js';
import { createServer, VERSION } from './server.js';

const HELP = `Figma listen ${VERSION} — local Figma activity events over MCP stdio

Usage: figma-listen [auth|logout|doctor] [options]

  (no command)          Start the stdio MCP server
  auth                  Validate and save a token in the system credential store
  logout                Remove the saved token (does not change the environment)
  doctor                Validate authentication and report configuration

Options:
  --state-dir PATH      Persistent state directory (one process per directory)
  --poll-interval SECS  Desired resource polling interval; default 3, minimum 1
  --request-interval MS Minimum spacing between Figma requests; default 2000
  --help                Show this help
  --version             Print version

FIGMA_ACCESS_TOKEN overrides saved credentials.
FIGMA_LISTEN_STATE_DIR overrides the default state directory.
Push requires an MCP Events capable host. Retrieval tools work on ordinary MCP clients.
`;
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    'state-dir': { type: 'string' }, 'poll-interval': { type: 'string' }, 'request-interval': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (positionals.length > 1 || (positionals[0] && !['auth','logout','doctor'].includes(positionals[0]))) throw new Error('Unknown command. Run figma-listen --help.');
  if (positionals[0] === 'auth') { await authenticate(); return; }
  if (positionals[0] === 'logout') {
    await (await credentialEntry()).deleteCredential();
    process.stderr.write('Saved token removed. FIGMA_ACCESS_TOKEN, if set, still takes precedence.\n'); return;
  }
  const interval = Number(values['poll-interval'] ?? 3) * 1000;
  const spacing = Number(values['request-interval'] ?? 2000);
  if (!Number.isFinite(interval) || interval < 1000 || interval > 86400000) throw new Error('--poll-interval must be between 1 and 86400 seconds');
  if (!Number.isFinite(spacing) || spacing < 0 || spacing > 60000) throw new Error('--request-interval must be between 0 and 60000 milliseconds');
  const directory = resolve(values['state-dir'] ?? process.env.FIGMA_LISTEN_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'figma-listen'));
  const figma = new FigmaClient(await loadToken(), { requestIntervalMs: spacing });
  let engine: ListenEngine | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const user = await figma.me();
    if (typeof user.id !== 'string') throw new Error('Figma returned an invalid authenticated identity');
    if (positionals[0] === 'doctor') {
      process.stdout.write(JSON.stringify({ version: VERSION, authenticated: true, user_id: user.id,
        token_source: process.env.FIGMA_ACCESS_TOKEN?.trim() ? 'environment' : 'credential_store',
        state_directory: directory, poll_interval_ms: interval, request_interval_ms: spacing,
        polling_scheduler: 'FIFO; one pending or running job per resource',
        required_scopes: ['current_user:read','file_comments:read'],
        optional_scopes: ['file_content:read','folders:read'],
        push_compatibility: 'Requires a host implementing the draft MCP Events extension; not verified for Codex.' }, null, 2) + '\n');
      figma.close(); return;
    }
    const store = new StateStore(directory); await store.open(user.id);
    engine = new ListenEngine(store, figma, { pollIntervalMs: interval });
    engine.on('pollError', (error: Error) => process.stderr.write(`figma-listen: ${error.message}\n`));
    let closing = false;
    const handle = serveStdio(() => createServer(engine!));
    shutdown = async () => {
      if (closing) return; closing = true; figma.close(); await handle.close(); await engine!.close();
    };
    const stop = () => { void shutdown!().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    engine.start();
    process.stderr.write(`Figma listen ${VERSION} ready (stdio; REST polling).\n`);
  } catch (error) {
    figma.close(); if (engine) await engine.close(); throw error;
  }
}
main().catch(error => { process.stderr.write(`figma-listen: ${error instanceof Error ? error.message : 'Startup failed'}\n`); process.exitCode = 1; });
