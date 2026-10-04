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

test('design reads use shallow document versions and vector geometry; malformed snapshots fail before diffing', async () => {
  const paths = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async url => {
    paths.push(url.pathname + url.search);
    return new Response(JSON.stringify(url.pathname.endsWith('/meta') ? { file: { name: 'Design', version: 'v2' } } :
      { name: 'Design', version: 'v2', document: { id: '0:0', type: 'DOCUMENT' } }));
  } });
  assert.deepEqual(await client.metadata('fileA'), { name: 'Design', version: 'v2' });
  assert.equal((await client.file('fileA')).document.id, '0:0');
  assert.deepEqual(paths, ['/v1/files/fileA?depth=1', '/v1/files/fileA?geometry=paths']);
  client.close();
  const invalid = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async () => new Response('{}') });
  await assert.rejects(invalid.metadata('fileA'), /invalid file metadata/);
  await assert.rejects(invalid.file('fileA'), /invalid file response/);
  invalid.close();
});

test('reaction fallback follows all pages with opaque cursors and rejects incomplete/repeated pagination', async () => {
  const calls = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async url => {
    calls.push(url.searchParams.get('cursor'));
    const second = url.searchParams.has('cursor');
    return new Response(JSON.stringify({ reactions: [{ emoji: second ? ':heart:' : ':+1:' }],
      pagination: { next_page: second ? null : 'opaque/+?cursor' } }));
  } });
  assert.equal((await client.reactions('fileA', 'comment')).length, 2);
  assert.deepEqual(calls, [null, 'opaque/+?cursor']); client.close();
  const repeating = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async () =>
    new Response(JSON.stringify({ reactions: [], pagination: { next_page: 'same' } })) });
  await assert.rejects(repeating.reactions('fileA', 'comment'), /repeated cursor/); repeating.close();
});
