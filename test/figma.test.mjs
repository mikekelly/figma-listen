import test from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient, FigmaError } from '../dist/figma.js';
import { loadToken } from '../dist/auth.js';

test('authentication remains in headers; errors never echo server bodies or tokens', async () => {
  const token = 'test-secret-not-a-real-token';
  let received;
  const client = new FigmaClient(token, { requestIntervalMs: 0, fetch: async (url, init) => {
    received = { url: String(url), init };
    return new Response(JSON.stringify({ error: token }), { status: 403 });
  } });
  await assert.rejects(client.me(), error => error instanceof FigmaError && !error.message.includes(token));
  assert.equal(received.init.headers['X-Figma-Token'], token);
  assert.equal(received.url.includes(token), false);
  assert.equal(received.init.redirect, 'error');
  await assert.rejects(client.get('https://example.com'), /cross-origin/);
  assert.equal(await loadToken({ FIGMA_ACCESS_TOKEN: ` ${token} ` }), token);
  client.close();
});

test('429 backs off all subsequent requests and shutdown cancels the wait', async () => {
  let calls = 0;
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async () => {
    calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } });
  } });
  await assert.rejects(client.me(), error => error.status === 429 && error.retryAfterMs === 3600000);
  const waiting = client.me();
  await new Promise(resolve => setTimeout(resolve, 20)); client.close();
  await assert.rejects(waiting, /closed/);
  assert.equal(calls, 1);
});

test('recursive v2 discovery deduplicates files and reports partial organization coverage', async () => {
  const routes = {
    '/v2/teams/teamA/folders': { folders: [{ id: 'root' }] },
    '/v2/folders/root/files': { files: [{ key: 'fileA' }] },
    '/v2/folders/root/folders': { folders: [{ id: 'child' }] },
    '/v2/folders/child/files': { files: [{ key: 'fileA' }, { key: 'fileB' }] },
    '/v2/folders/child/folders': { folders: [{ id: 'root' }] },
  };
  const paths = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async url => {
    paths.push(url.pathname);
    return new Response(JSON.stringify(routes[url.pathname] ?? {}), { status: routes[url.pathname] ? 200 : 403 });
  } });
  const result = await client.discover({ kind: 'organization', organization_id: 'org', team_ids: ['teamA', 'hidden'] });
  assert.deepEqual(result.files.map(f => f.key), ['fileA', 'fileB']);
  assert.match(result.warnings.join(' '), /supplied team IDs/);
  assert.match(result.warnings.join(' '), /hidden.*403/);
  assert.equal(paths.filter(p => p === '/v2/folders/root/files').length, 1);
  client.close();
});
