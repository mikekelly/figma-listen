import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { createServer } from '../dist/server.js';
import { fixture, comment, fileScope } from './helpers.mjs';

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected state transition did not complete');
}

async function wireFixture(t, modern = false) {
  const fixtureData = await fixture(t);
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const messages = []; let partial = ''; const waiters = new Set();
  stdout.on('data', chunk => {
    partial += chunk.toString(); let end;
    while ((end = partial.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1);
    }
    for (const check of waiters) check();
  });
  const transport = new StdioServerTransport(stdin, stdout);
  const handle = serveStdio(() => createServer(fixtureData.engine), { transport });
  t.after(async () => { await handle.close(); stdin.destroy(); stdout.destroy(); });
  let nextId = 0;
  const meta = modern ? {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'figma-listen-test', version: '1' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  } : undefined;
  const send = (method, params = {}, id) => {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method,
      params: { ...params, ...(meta ? { _meta: meta } : {}) } }) + '\n');
  };
  const wait = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Wire timeout: ${JSON.stringify(messages)}`)); }, 3000);
    const check = () => {
      const index = messages.findIndex(predicate);
      if (index !== -1) { clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]); }
    };
    waiters.add(check); check();
  });
  const request = async (method, params = {}) => {
    const id = ++nextId; send(method, params, id);
    const response = await wait(m => m.id === id);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  if (modern) await request('server/discover');
  else {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'figma-listen-test', version: '1' } });
    send('notifications/initialized');
  }
  return { ...fixtureData, request, send, wait, handle };
}

for (const modern of [false, true]) test(`tools work over ${modern ? '2026 stateless envelopes' : '2025 initialize'} stdio`, async t => {
  const { request, engine, figma } = await wireFixture(t, modern);
  const listed = await request('tools/list');
  assert.deepEqual(listed.tools.map(t => t.name).sort(), ['listen_get_events', 'listen_list_subscriptions',
    'listen_status', 'listen_subscribe', 'listen_unsubscribe']);
  const catalog = await request('events/list');
  assert.equal(catalog.events[0].name, 'figma.comment.created');
  const result = await request('tools/call', { name: 'listen_subscribe', arguments: fileScope });
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  figma.snapshots.set('fileA', [comment('new', 'Hello #bot')]); await engine.tick();
  const events = await request('tools/call', { name: 'listen_get_events', arguments: { subscription_id: data.subscription.id } });
  const batch = events.structuredContent ?? JSON.parse(events.content[0].text);
  assert.equal(batch.events[0].data.comment_id, 'new');
  await request('tools/call', { name: 'listen_unsubscribe', arguments: { subscription_id: data.subscription.id } });
  assert.equal(engine.subscriptions().length, 0);
});

test('draft push streams deliver correlated events, replay cursors, and stop on cancellation', async t => {
  const { engine, figma, request, send, wait } = await wireFixture(t);
  send('events/stream', { name: 'figma.comment.created', arguments: { ...fileScope, tag: '#bot' }, cursor: null }, 'stream1');
  const active = await wait(m => m.method === 'notifications/events/active');
  assert.equal(active.params._meta['io.modelcontextprotocol/subscriptionId'], 'stream1');
  const cursor = active.params.cursor;
  // Two streams share a local subscription, with independent cancellation.
  send('events/stream', { name: 'figma.comment.created', arguments: { ...fileScope, tag: '#bot' }, cursor: null }, 'stream2');
  await wait(m => m.method === 'notifications/events/active');
  send('notifications/cancelled', { requestId: 'stream1' });
  await eventually(() => engine.listenerCount('events') === 1);
  assert.equal(engine.subscriptions().length, 1);
  figma.snapshots.set('fileA', [comment('event', 'Please #bot review')]); await engine.tick();
  const pushed = await wait(m => m.method === 'notifications/events/event');
  assert.equal(pushed.params._meta['io.modelcontextprotocol/subscriptionId'], 'stream2');
  assert.equal(pushed.params.data.comment_id, 'event');
  const polled = await request('events/poll', { name: 'figma.comment.created', arguments: { ...fileScope, tag: '#bot' }, cursor });
  assert.equal(polled.events[0].eventId, pushed.params.eventId);
  send('notifications/cancelled', { requestId: 'stream2' }); await eventually(() => engine.listenerCount('events') === 0);
  assert.equal(engine.subscriptions()[0].source, 'poll', 'polling retains its lease after a shared stream closes');
});

test('stream cancellation preserves a subscription created or promoted by a tool', async t => {
  const { engine, send, wait, request } = await wireFixture(t);
  send('events/stream', { name: 'figma.comment.created', arguments: fileScope, cursor: null }, 'persistent');
  await wait(m => m.method === 'notifications/events/active');
  await request('tools/call', { name: 'listen_subscribe', arguments: fileScope });
  send('notifications/cancelled', { requestId: 'persistent' }); await eventually(() => engine.listenerCount('events') === 0);
  assert.equal(engine.subscriptions()[0].source, 'tool');
});
