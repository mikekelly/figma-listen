import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceQueue } from '../dist/queue.js';
import { FigmaClient } from '../dist/figma.js';
import { ListenEngine } from '../dist/engine.js';
import { FakeFigma, fileScope, comment } from './helpers.mjs';

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  return async milliseconds => { t.mock.timers.tick(milliseconds); await settle(); };
}
function memoryStore() {
  return { state: { version: 1, epoch: 'test', ownerId: 'user', sequence: 0,
    subscriptions: [], seen: {}, events: [], droppedThrough: 0 },
  async save() {}, async close() {} };
}

test('FIFO starts are paced without waiting for slow responses; queued and running keys coalesce', async t => {
  const advance = clock(t);
  const queue = new ResourceQueue({ maxConcurrent: 2, startIntervalMs: 2000 });
  const slow = deferred(); const started = [];
  const a = queue.enqueue('A', async () => { started.push('A'); await slow.promise; return 'result A'; });
  const b = queue.enqueue('B', async () => { started.push('B'); return 'result B'; });
  assert.equal(queue.enqueue('A', () => assert.fail('duplicate active resource ran')), a);
  assert.equal(queue.enqueue('B', () => assert.fail('duplicate queued resource ran')), b);
  await settle(); assert.deepEqual(started, ['A']);
  await advance(1999); assert.deepEqual(started, ['A']);
  await advance(1); assert.deepEqual(started, ['A', 'B'], 'B starts while A is still waiting');
  assert.equal(await b, 'result B');
  assert.deepEqual(queue.status().running_resources, ['A']);
  slow.resolve(); assert.equal(await a, 'result A'); await queue.idle(); await queue.close();
});

test('bounded workers preserve FIFO order when all concurrency slots are occupied', async () => {
  const queue = new ResourceQueue({ maxConcurrent: 2 });
  const gates = [deferred(), deferred(), deferred()]; const started = [];
  const tasks = gates.map((gate, index) => queue.enqueue(String(index), async () => {
    started.push(index); await gate.promise;
  }));
  await settle(); assert.deepEqual(started, [0, 1]);
  assert.equal(queue.status().queued_resources, 1);
  gates[0].resolve(); await settle(); assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve(); gates[2].resolve(); await Promise.all(tasks); await queue.close();
});

test('closing a backed-off queue rejects pending work promptly without dispatching it', async t => {
  clock(t);
  const queue = new ResourceQueue({ startIntervalMs: 2000 });
  queue.pause(3600000);
  const pending = queue.enqueue('never', () => assert.fail('paused job was dispatched'));
  const rejection = assert.rejects(pending, /closed/);
  await queue.close(); await rejection;
  assert.equal(queue.status().queued_resources, 0);
});

test('HTTP dispatcher respects Retry-After globally while preserving FIFO work and coalescing duplicate URLs', async t => {
  const advance = clock(t);
  const calls = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 2000, fetch: async url => {
    calls.push(url.pathname);
    return url.pathname === '/v1/me' ? new Response('{}', { status: 429, headers: { 'Retry-After': '10' } })
      : new Response(JSON.stringify({ comments: [] }));
  } });
  const limited = assert.rejects(client.me(), error => error.status === 429);
  const waiting = client.comments('fileA');
  const shared = client.comments('fileA');
  await settle(); await limited;
  assert.deepEqual(calls, ['/v1/me']);
  assert.ok(client.requestStatus().backoff_until);
  await advance(9999); assert.deepEqual(calls, ['/v1/me']);
  await advance(1); await Promise.all([waiting, shared]);
  assert.deepEqual(calls, ['/v1/me', '/v1/files/fileA/comments']);
  client.close();
});

test('a slow upstream HTTP request does not block another resource at the next rate slot', async t => {
  const advance = clock(t);
  const slow = deferred(); const calls = [];
  const client = new FigmaClient('fake', { requestIntervalMs: 2000, fetch: async url => {
    calls.push(url.pathname);
    if (url.pathname.includes('slow')) await slow.promise;
    return new Response(JSON.stringify({ comments: [] }));
  } });
  const first = client.comments('slow'); const second = client.comments('fast');
  await settle(); assert.equal(calls.length, 1);
  await advance(2000); assert.equal(calls.length, 2);
  assert.deepEqual(await second, []);
  assert.equal(client.requestStatus().running_resources.length, 1);
  slow.resolve(); await first; client.close();
});

test('three-second producer continues during slow work, bounds duplicates, and leaves subscription tools responsive', async t => {
  const advance = clock(t);
  const figma = new FakeFigma(); const slow = deferred();
  figma.comments = async key => {
    figma.calls.push(key);
    if (key === 'fileA') await slow.promise;
    return [];
  };
  const engine = new ListenEngine(memoryStore(), figma);
  const a = await engine.subscribe(fileScope);
  await engine.subscribe({ scope: { kind: 'file', file_key: 'fileB' } });
  engine.start(); await advance(0);
  assert.deepEqual(figma.calls, ['fileA', 'fileB']);
  await advance(3000); await advance(3000); await advance(3000);
  assert.equal(figma.calls.filter(key => key === 'fileA').length, 1);
  assert.equal(figma.calls.filter(key => key === 'fileB').length, 4);
  assert.equal(engine.pollingStatus().queued_resources, 0);
  assert.ok(engine.pollingStatus().coalesced_requests >= 3);
  await engine.unsubscribe(a.id);
  assert.equal(engine.subscriptions().length, 1, 'unsubscribe does not wait for slow Figma I/O');
  slow.resolve(); await settle(); await engine.close();
});

test('failed resources back off exponentially without slowing healthy resources, then reset after recovery', async t => {
  const advance = clock(t);
  const figma = new FakeFigma(); let failing = true;
  figma.comments = async key => {
    figma.calls.push(key);
    if (key === 'fileA' && failing) throw new Error('temporary failure');
    return [];
  };
  const engine = new ListenEngine(memoryStore(), figma);
  await engine.subscribe(fileScope);
  await engine.subscribe({ scope: { kind: 'file', file_key: 'fileB' } });
  engine.start(); await advance(0);
  await advance(3000); assert.equal(figma.calls.filter(key => key === 'fileA').length, 1);
  await advance(3000); assert.equal(figma.calls.filter(key => key === 'fileA').length, 2);
  await advance(3000); await advance(3000); await advance(3000);
  assert.equal(figma.calls.filter(key => key === 'fileA').length, 2);
  failing = false; await advance(3000);
  assert.equal(figma.calls.filter(key => key === 'fileA').length, 3);
  await advance(3000); assert.equal(figma.calls.filter(key => key === 'fileA').length, 4);
  assert.equal(figma.calls.filter(key => key === 'fileB').length, 8);
  await engine.close();
});

test('overlapping folder scopes share discovery and newly added tag subscriptions reuse the coverage', async () => {
  const figma = new FakeFigma(); let discoveries = 0;
  figma.discover = async () => { discoveries++; return { files: [{ key: 'fileA' }], warnings: [] }; };
  const engine = new ListenEngine(memoryStore(), figma);
  const scope = { kind: 'folder', folder_id: 'folderA' };
  await engine.subscribe({ scope }); await engine.subscribe({ scope, tag: '#other' });
  await engine.tick(); assert.equal(discoveries, 1);
  const tagged = await engine.subscribe({ scope, tag: '#bot' });
  figma.snapshots.set('fileA', [comment('new', '#bot please review')]); await engine.tick();
  assert.equal(discoveries, 1);
  assert.equal(engine.read(tagged.id).events.length, 1);
  await engine.close();
});

test('slow design fetches leave same-file comments and the independent polling timer running', async t => {
  const advance = clock(t);
  const figma = new FakeFigma(); const slow = deferred();
  const file = await figma.file(); let designReads = 0;
  figma.file = async () => { designReads++; await slow.promise; return file; };
  const engine = new ListenEngine(memoryStore(), figma);
  const sub = await engine.subscribe(fileScope);
  engine.start(); await advance(0);
  assert.equal(designReads, 1);
  figma.snapshots.set('fileA', [comment('new', 'During slow design request')]);
  await advance(3000);
  assert.equal(engine.read(sub.id).events[0].data.comment_id, 'new');
  await advance(3000);
  assert.equal(designReads, 1, 'one design job stays in flight, with no duplicates');
  assert.equal(figma.calls.length, 3, 'comments keep polling while the design job waits');
  slow.resolve(); await settle(); await engine.close();
});
