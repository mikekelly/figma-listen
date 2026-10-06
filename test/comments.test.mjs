import test from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient, FigmaError } from '../dist/figma.js';
import { commentInputSchema } from '../dist/schema.js';
import { fixture, comment, fileScope } from './helpers.mjs';

const scopeDenied = scopes => new Response(JSON.stringify({ error: true, status: 403,
  message: `Invalid scope: ${JSON.stringify(scopes).replace(/,/g, ', ')}. This endpoint requires the file_read or webhooks:read scope.` }), { status: 403 });

test('scope probes read the granted scopes from a rejection without writing', async () => {
  const calls = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 60000, fetch: async (url, init) => {
    calls.push(`${init.method} ${url.pathname} ${init.body ?? ''}`);
    return scopeDenied(['current_user:read', 'file_comments:read', 'file_comments:write']);
  } });
  assert.deepEqual(await client.scopes(), ['current_user:read', 'file_comments:read', 'file_comments:write']);
  assert.deepEqual(calls, ['GET /v2/webhooks ']);
  client.close();
});

test('scope probing falls back to an empty dev resource write, then reports unknown', async () => {
  const calls = [];
  let deny = true;
  const client = new FigmaClient('fake', { requestIntervalMs: 60000, fetch: async (url, init) => {
    calls.push(`${init.method} ${url.pathname} ${init.body ?? ''}`);
    if (url.pathname === '/v2/webhooks') return new Response('{"status":400,"err":"Missing context"}', { status: 400 });
    return deny ? scopeDenied(['file_comments:read']) : new Response('{"status":400,"err":"Bad request"}', { status: 400 });
  } });
  assert.deepEqual(await client.scopes(), ['file_comments:read']);
  assert.deepEqual(calls, ['GET /v2/webhooks ', 'POST /v1/dev_resources {}']);
  deny = false;
  assert.equal(await client.scopes(), null);
  client.close();
});

test('scope rejections expose only a well-formed scope list, never the body', async () => {
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async () => new Response(JSON.stringify({
    message: 'Invalid scope: ["file_comments:read", "<script>"]. secret' }), { status: 403 }) });
  await assert.rejects(client.me(), error => error instanceof FigmaError && error.grantedScopes === undefined &&
    !error.message.includes('secret'));
  client.close();
});

test('comment posts send JSON and are never coalesced with a concurrent post', async () => {
  const bodies = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 0, fetch: async (url, init) => {
    bodies.push(JSON.parse(init.body));
    assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/json');
    return new Response(JSON.stringify({ id: String(bodies.length), message: 'x', created_at: new Date().toISOString(), user: { id: 'u' } }));
  } });
  const [a, b] = await Promise.all([client.postComment('fileA', { message: 'one' }), client.postComment('fileA', { message: 'two' })]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(bodies.map(b => b.message).sort(), ['one', 'two']);
  client.close();
});

test('comment input accepts IDs or Figma URLs and keeps replies unpinned', () => {
  assert.deepEqual(commentInputSchema.parse({ url: 'https://www.figma.com/design/fileA/x?node-id=1-2', message: ' Hi ' }),
    { file_key: 'fileA', message: 'Hi', node_id: '1:2', node_offset: { x: 0, y: 0 } });
  assert.deepEqual(commentInputSchema.parse({ url: 'https://www.figma.com/design/fileA/x?node-id=1-2', message: 'Hi', reply_to: '9' }),
    { file_key: 'fileA', message: 'Hi', reply_to: '9' });
  assert.deepEqual(commentInputSchema.parse({ file_key: 'fileA', message: 'Hi', node_id: '3-4', node_offset: { x: 5, y: 6 } }),
    { file_key: 'fileA', message: 'Hi', node_id: '3:4', node_offset: { x: 5, y: 6 } });
  for (const invalid of [{ message: 'Hi' }, { file_key: 'fileA', url: 'https://www.figma.com/design/fileA', message: 'Hi' },
    { url: 'https://example.com/design/fileA', message: 'Hi' }, { file_key: 'fileA', message: '  ' },
    { file_key: 'fileA', message: 'Hi', reply_to: '9', node_id: '1:2' }, { file_key: 'fileA', message: 'Hi', node_offset: { x: 0, y: 0 } }])
    assert.equal(commentInputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test('own comments are not echoed, even when a poll snapshot lands before the POST response', async t => {
  const { engine, figma } = await fixture(t);
  const sub = await engine.subscribe(fileScope);
  await engine.tick();
  let respond;
  figma.respond = () => new Promise(resolve => { respond = resolve; });
  const posting = engine.postComment({ file_key: 'fileA', message: 'Agent note' });
  await new Promise(resolve => setImmediate(resolve));
  // The comment already exists upstream, so this poll sees it before the server knows its ID.
  const polling = engine.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  respond();
  const posted = await posting; await polling;
  assert.equal(posted.comment_id, 'posted-1');
  figma.snapshots.get('fileA').push(comment('human', 'A person'));
  await engine.tick();
  assert.deepEqual(engine.read(sub.id).events.map(e => e.data.comment_id), ['human']);
  assert.equal(engine.commentAccess, 'granted');
});

test('replies target the thread root, and a scope rejection withdraws commenting', async t => {
  const { engine, figma } = await fixture(t);
  await engine.subscribe(fileScope);
  figma.snapshots.set('fileA', [comment('root', 'Root', { created_at: '2020-01-01T00:00:00Z' }),
    comment('reply', 'Reply', { parent_id: 'root', created_at: '2020-01-01T00:00:01Z' })]);
  await engine.tick();
  const result = await engine.postComment({ file_key: 'fileA', message: 'Agreed', reply_to: 'reply' });
  assert.equal(figma.posted[0].body.comment_id, 'root');
  assert.equal(result.thread_id, 'root');
  const changes = [];
  engine.on('commentAccess', access => changes.push(access));
  figma.postError = new FigmaError('Figma HTTP 403.', 403, 0, ['file_comments:read']);
  await assert.rejects(engine.postComment({ file_key: 'fileA', message: 'Again' }), /403/);
  assert.deepEqual(changes, ['missing']);
  await assert.rejects(engine.postComment({ file_key: 'fileA', message: 'Again' }), /file_comments:write/);
  figma.postError = new FigmaError('Figma HTTP 403.', 403);
  assert.equal(engine.commentAccess, 'missing');
});

test('a resource 403 without a scope report leaves commenting available', async t => {
  const { engine, figma } = await fixture(t);
  figma.postError = new FigmaError('Figma HTTP 403.', 403);
  await assert.rejects(engine.postComment({ file_key: 'fileA', message: 'Hi' }), /403/);
  assert.equal(engine.commentAccess, 'unverified');
});
