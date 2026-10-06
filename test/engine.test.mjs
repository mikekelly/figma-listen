import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StateStore } from '../dist/store.js';
import { WatchEngine } from '../dist/engine.js';
import { FigmaError } from '../dist/figma.js';
import { tagsIn, eventPayloadSchema } from '../dist/schema.js';
import { fixture, comment, fileScope } from './helpers.mjs';

test('baselines history, deduplicates shared polling, and delivers exact #bot matches and thread replies', async t => {
  const { engine, figma } = await fixture(t);
  const root = comment('old', 'Please #bot review', { created_at: '2020-01-01T00:00:00Z' });
  figma.snapshots.set('fileA', [root]);
  const all = await engine.subscribe(fileScope);
  const tagged = await engine.subscribe({ ...fileScope, tag: '#bot' });
  const threads = await engine.subscribe({ ...fileScope, tag: '#bot', include_thread_replies: true });
  await engine.tick();
  assert.equal(engine.read(all.id).events.length, 0);
  figma.snapshots.set('fileA', [root, comment('one', 'Hello #bot'), comment('two', '#botnet'),
    comment('three', 'An untagged reply', { parent_id: 'old' }), comment('four', '#Bot')]);
  await engine.tick();
  assert.equal(figma.calls.length, 2, 'one request per file per cycle, shared across subscriptions');
  assert.deepEqual(engine.read(all.id).events.map(e => e.data.comment_id).sort(), ['four', 'one', 'three', 'two']);
  assert.deepEqual(engine.read(tagged.id).events.map(e => e.data.comment_id), ['one']);
  assert.deepEqual(engine.read(threads.id).events.map(e => e.data.comment_id), ['one', 'three']);
  const batch = engine.read(all.id, undefined, 2);
  assert.equal(batch.hasMore, true);
  assert.equal(engine.read(all.id, batch.cursor).events.length, 2);
  const final = engine.read(all.id);
  await engine.tick();
  assert.equal(engine.read(all.id, final.cursor).events.length, 0);
  assert.deepEqual(tagsIn('a#bot #bot #botnet #böt, #bot'), ['#bot', '#botnet', '#böt']);
});

test('page and frame filters map nested anchors and inherit reply anchors, excluding unmapped comments', async t => {
  const { engine, figma } = await fixture(t);
  const page = await engine.subscribe({ scope: { kind: 'page', file_key: 'fileA', page_id: '1-1' } });
  const frame = await engine.subscribe({ scope: { kind: 'frame', file_key: 'fileA', node_id: '2:1' } });
  const all = await engine.subscribe(fileScope);
  figma.snapshots.set('fileA', [comment('a', '#bot', { client_meta: { node_id: '3:1' } }),
    comment('b', 'Reply', { parent_id: 'a' }), comment('c', 'Other page', { client_meta: { node_id: '4:1' } }),
    comment('d', 'Canvas coordinate only', { client_meta: { x: 100, y: 100 } })]);
  await engine.tick();
  assert.deepEqual(engine.read(page.id).events.map(e => e.data.comment_id), ['a', 'b']);
  assert.deepEqual(engine.read(frame.id).events.map(e => e.data.comment_id), ['a', 'b']);
  assert.equal(engine.read(all.id).events.length, 4);
  assert.equal(engine.subscription(page.id).coverage.excluded_unanchored_comments, 1);
  assert.equal(engine.subscription(page.id).coverage.complete, false);
});

test('durable replay, owner binding, exclusive locking, and retention gaps', async t => {
  const { engine, figma, store, directory } = await fixture(t, { maxEvents: 2 });
  const sub = await engine.subscribe(fileScope);
  const start = engine.cursor(sub.id);
  const duplicate = new StateStore(directory);
  await assert.rejects(duplicate.open('user'), /Another Figma watch/);
  figma.snapshots.set('fileA', [comment('a', 'a'), comment('b', 'b'), comment('c', 'c')]);
  await engine.tick();
  assert.equal(engine.read(sub.id, start).truncated, true);
  assert.equal(engine.read(sub.id, start).events.length, 2);
  const last = engine.read(sub.id).events[0].cursor;
  await engine.close();
  const other = new StateStore(directory);
  await assert.rejects(other.open('different-user'), /another Figma account/);
  const reopened = new StateStore(directory); await reopened.open('user');
  const resumed = new WatchEngine(reopened, figma);
  t.after(() => resumed.close());
  assert.equal(resumed.read(sub.id, last).events.length, 1);
  await resumed.tick();
  assert.equal(reopened.state.sequence, 3, 'restart does not redeliver already observed IDs');
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'state.json'), 'utf8')).includes('token'), false);
  await resumed.close();
  // Prevent the original fixture cleanup from overwriting restored state.
  store.state = reopened.state;
});

test('null cursor bootstraps now; foreign or invalid cursors fail; access denial suppresses buffered delivery', async t => {
  const { engine, figma } = await fixture(t);
  const sub = await engine.subscribe(fileScope);
  figma.snapshots.set('fileA', [comment('a', 'a')]); await engine.tick();
  assert.equal(engine.read(sub.id, null).events.length, 0);
  const second = await engine.subscribe({ ...fileScope, tag: '#bot' });
  assert.throws(() => engine.read(second.id, engine.cursor(sub.id)), /different subscription/);
  assert.throws(() => engine.read(sub.id, 'bad'), /Invalid cursor/);
  figma.error = new FigmaError('Figma HTTP 403. Access denied.', 403);
  await assert.rejects(engine.tick(), /403/);
  assert.equal(engine.read(sub.id).events.length, 0);
  assert.match(engine.subscription(sub.id).coverage.last_error, /403/);
});

test('folder discovery refreshes dynamically and canonical subscriptions are idempotent', async t => {
  const { engine, figma } = await fixture(t, { discoveryIntervalMs: -1 });
  const input = { scope: { kind: 'folder', folder_id: 'folderA' } };
  const sub = await engine.subscribe(input);
  assert.equal((await engine.subscribe({ include_thread_replies: false, scope: { recursive: true, ...input.scope } })).id, sub.id);
  await engine.tick();
  figma.discovered.push({ key: 'fileB' }); figma.snapshots.set('fileB', [comment('b', 'New file')]);
  await engine.tick();
  assert.equal(engine.read(sub.id).events[0].data.file_key, 'fileB');
});

test('projects REST user metadata to the advertised payload and deduplicates IDs within snapshots', async t => {
  const { engine, figma } = await fixture(t);
  const sub = await engine.subscribe(fileScope);
  const item = comment('one', 'Hello', { user: { id: 'user', handle: 'Designer', img_url: 'https://example.com/avatar' } });
  figma.snapshots.set('fileA', [item, item]); await engine.tick();
  const events = engine.read(sub.id).events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data.author, { id: 'user', handle: 'Designer' });
  assert.deepEqual(eventPayloadSchema.parse(events[0].data), events[0].data);
});
