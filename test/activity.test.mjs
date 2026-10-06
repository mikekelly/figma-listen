import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../dist/store.js';
import { WatchEngine } from '../dist/engine.js';
import { eventPayloadSchema, subscriptionSchema, eventNames } from '../dist/schema.js';
import { FigmaError } from '../dist/figma.js';
import { fixture, comment, fileScope } from './helpers.mjs';

const old = (id, text = 'Review #bot', extra = {}) => comment(id, text, { created_at: '2020-01-01T00:00:00Z', ...extra });
const reaction = emoji => ({ user: { id: 'reviewer', handle: 'Reviewer' }, emoji, created_at: '2020-01-01T00:00:00Z' });
const names = batch => batch.events.map(e => e.name);
function timing(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return () => t.mock.timers.tick(1000);
}
async function designFixture(t, options = { designQuietPeriodMs: 0 }) {
  const data = await fixture(t, options);
  let document = { name: 'Design', version: '1', document: { id: '0:0', type: 'DOCUMENT', children: [
    { id: '1:1', type: 'CANVAS', name: 'Checkout', children: [
      { id: '2:1', type: 'SECTION', name: 'Payment', children: [
        { id: '3:1', type: 'FRAME', name: 'Card', children: [
          { id: '4:1', type: 'TEXT', name: 'Label', characters: 'Pay', fills: [{ color: 'blue' }] },
        ] },
      ] },
      { id: '2:2', type: 'SECTION', name: 'Other', children: [] },
    ] },
    { id: '1:2', type: 'CANVAS', name: 'Other page', children: [] },
  ] } };
  let fetches = 0, metadataCalls = 0;
  data.figma.file = async () => { fetches++; return structuredClone(document); };
  data.figma.metadata = async () => { metadataCalls++; return { name: document.name, version: document.version }; };
  return { ...data, doc: () => document, counts: () => ({ fetches, metadataCalls }),
    edit(fn) { fn(document); document.version = String(Number(document.version) + 1); } };
}
const section = { scope: { kind: 'section', file_key: 'fileA', node_id: '2:1' } };
const designTypes = ['figma.design.changed', 'figma.scope.deleted'];

test('historical comments baseline, then edits, resolutions, reopenings and deletion are delivered with previous context', async t => {
  const advance = timing(t);
  const { engine, figma } = await fixture(t);
  const sub = await engine.subscribe({ ...fileScope, tag: '#bot', event_types: eventNames.filter(n => n.startsWith('figma.comment.')) });
  figma.snapshots.set('fileA', [old('root')]); await engine.tick();
  assert.equal(engine.read(sub.id).events.length, 0);
  advance(); figma.snapshots.set('fileA', [old('root', 'Edited without tag')]); await engine.tick();
  let batch = engine.read(sub.id);
  assert.deepEqual(names(batch), ['figma.comment.edited']);
  assert.equal(batch.events[0].data.previous_text, 'Review #bot');
  advance(); figma.snapshots.set('fileA', [old('root', 'Edited #bot', { resolved_at: new Date().toISOString() })]); await engine.tick();
  batch = engine.read(sub.id, batch.cursor);
  assert.deepEqual(names(batch), ['figma.comment.edited', 'figma.comment.resolved']);
  advance(); figma.snapshots.set('fileA', [old('root', 'Edited #bot')]); await engine.tick();
  batch = engine.read(sub.id, batch.cursor); assert.deepEqual(names(batch), ['figma.comment.reopened']);
  advance(); figma.snapshots.set('fileA', []); await engine.tick();
  batch = engine.read(sub.id, batch.cursor); assert.deepEqual(names(batch), ['figma.comment.deleted']);
  assert.equal(batch.events[0].data.text, 'Edited #bot');
  await engine.tick(); assert.equal(engine.read(sub.id, batch.cursor).events.length, 0);
  for (const event of engine.read(sub.id).events) assert.deepEqual(eventPayloadSchema.parse(event.data), event.data);
});

test('section-scoped deletion retains root anchor and thread tag when root and reply disappear together', async t => {
  const advance = timing(t);
  const { engine, figma } = await designFixture(t);
  const sub = await engine.subscribe({ ...section, event_types: ['figma.comment.deleted'], tag: '#bot', include_thread_replies: true });
  figma.snapshots.set('fileA', [old('root', '#bot', { client_meta: { node_id: '4:1' } }), old('reply', 'Yes', { parent_id: 'root' })]);
  await engine.tick(); advance(); figma.snapshots.set('fileA', []); await engine.tick();
  assert.deepEqual(engine.read(sub.id).events.map(e => e.data.comment_id).sort(), ['reply', 'root']);
});

test('reaction additions/removals follow parent comment tags and scope; inline reaction history is baselined', async t => {
  const advance = timing(t);
  const { engine, figma } = await designFixture(t);
  const sub = await engine.subscribe({ ...section, tag: '#bot', include_thread_replies: true,
    event_types: ['figma.reaction.added', 'figma.reaction.removed'] });
  const root = old('root', '#bot', { client_meta: { node_id: '4:1' } });
  const reply = old('reply', 'Looks good', { parent_id: 'root', reactions: [reaction(':heart:')] });
  figma.snapshots.set('fileA', [root, reply]); await engine.tick();
  assert.equal(engine.read(sub.id).events.length, 0);
  advance(); reply.reactions.push(reaction(':+1:')); await engine.tick();
  let batch = engine.read(sub.id); assert.deepEqual(names(batch), ['figma.reaction.added']);
  assert.equal(batch.events[0].data.reaction.emoji, ':+1:');
  assert.equal(batch.events[0].data.reaction.user.id, 'reviewer');
  advance(); reply.reactions = []; await engine.tick();
  batch = engine.read(sub.id, batch.cursor); assert.deepEqual(names(batch), ['figma.reaction.removed', 'figma.reaction.removed']);
});

test('fallback reaction requests recover from failures without blocking comment lifecycle delivery', async t => {
  const advance = timing(t);
  const { engine, figma } = await fixture(t, { pollIntervalMs: 1 });
  const sub = await engine.subscribe({ ...fileScope, event_types: ['figma.comment.edited', 'figma.reaction.added'] });
  let fail = false, items = [];
  figma.reactions = async () => { if (fail) throw new FigmaError('Figma HTTP 403', 403); return items; };
  figma.snapshots.set('fileA', [old('root', 'First', { reactions: undefined })]); await engine.tick();
  advance(); fail = true; figma.snapshots.set('fileA', [old('root', 'Second', { reactions: undefined })]);
  await assert.rejects(engine.tick(), /403/);
  assert.deepEqual(names(engine.read(sub.id)), ['figma.comment.edited']);
  advance(); fail = false; items = [reaction(':heart:')]; await engine.tick();
  assert.deepEqual(names(engine.read(sub.id)), ['figma.comment.edited', 'figma.reaction.added']);
  assert.equal(engine.subscription(sub.id).coverage.last_error, undefined);
});

test('design diffs cover text, color, added/removed nodes and scope membership moves, sharing document polls', async t => {
  const advance = timing(t);
  const { engine, edit, counts, figma } = await designFixture(t);
  const all = await engine.subscribe({ ...fileScope, event_types: designTypes });
  const scoped = await engine.subscribe({ ...section, event_types: designTypes, tag: '#bot' });
  const other = await engine.subscribe({ scope: { kind: 'section', file_key: 'fileA', node_id: '2:2' }, event_types: designTypes });
  await engine.tick(); await engine.tick();
  assert.deepEqual(counts(), { fetches: 2, metadataCalls: 0 });
  assert.equal(figma.calls.length, 0, 'design-only subscriptions never poll comments');
  advance(); edit(d => {
    const frame = d.document.children[0].children[0].children[0];
    frame.children[0].characters = 'Buy'; frame.children[0].fills = [{ color: 'red' }];
    frame.children.push({ id: '4:2', type: 'RECTANGLE', name: 'Icon' });
  }); await engine.tick();
  const batch = engine.read(scoped.id);
  assert.equal(batch.events.length, 1);
  const changed = batch.events[0].data.changes.find(c => c.node_id === '4:1');
  assert.deepEqual(changed.changed_properties, ['characters', 'fills']);
  assert.equal(batch.events[0].data.changes.find(c => c.node_id === '4:2').kind, 'added');
  assert.equal(engine.read(other.id).events.length, 0);
  advance(); edit(d => { const [a,b] = d.document.children[0].children; b.children.push(a.children.pop()); }); await engine.tick();
  assert.equal(engine.read(scoped.id, batch.cursor).events[0].data.changes.find(c => c.node_id === '3:1').kind, 'left');
  assert.equal(engine.read(other.id).events[0].data.changes.find(c => c.node_id === '3:1').kind, 'entered');
  assert.ok(engine.read(all.id).events.length >= 2);
  for (const event of engine.read(all.id).events) assert.deepEqual(eventPayloadSchema.parse(event.data), event.data);
});

test('watched section follows rename and movement to another page, emits deletion once and reports a missing target', async t => {
  const advance = timing(t);
  const { engine, edit } = await designFixture(t);
  const sub = await engine.subscribe({ ...section, event_types: designTypes });
  await engine.tick(); advance(); edit(d => {
    const target = d.document.children[0].children.shift(); target.name = 'New name'; d.document.children[1].children.push(target);
  }); await engine.tick();
  let batch = engine.read(sub.id); assert.deepEqual(names(batch), ['figma.design.changed']);
  assert.equal(batch.events[0].data.changes.find(c => c.node_id === '2:1').after.page_id, '1:2');
  advance(); edit(d => { d.document.children[1].children = []; }); await engine.tick();
  batch = engine.read(sub.id, batch.cursor);
  assert.deepEqual(names(batch), ['figma.design.changed', 'figma.scope.deleted']);
  assert.equal(engine.subscription(sub.id).coverage.target_status, 'missing');
  assert.equal(engine.subscription(sub.id).coverage.complete, false);
  await engine.tick(); assert.equal(engine.read(sub.id, batch.cursor).events.length, 0);
});

test('persisted snapshots detect changes after restart without repeating events or flooding baseline history', async t => {
  const advance = timing(t);
  const { engine, figma, directory, edit } = await designFixture(t);
  const sub = await engine.subscribe(fileScope);
  figma.snapshots.set('fileA', [old('root')]); await engine.tick();
  const cursor = engine.read(sub.id).cursor; await engine.close();
  advance(); edit(d => { d.document.children[0].name = 'Changed offline'; });
  figma.snapshots.set('fileA', [old('root', 'Edited offline')]);
  const store = new StateStore(directory); await store.open('user');
  const resumed = new WatchEngine(store, figma, { designQuietPeriodMs: 0 }); t.after(() => resumed.close());
  await resumed.tick();
  const batch = resumed.read(sub.id, cursor);
  assert.deepEqual(names(batch).sort(), ['figma.comment.edited', 'figma.design.changed']);
  await resumed.tick(); assert.equal(resumed.read(sub.id, batch.cursor).events.length, 0);
  await resumed.close();
});

test('new subscribers do not receive differences from before their first baseline', async t => {
  const advance = timing(t);
  const { engine, edit } = await designFixture(t);
  await engine.subscribe({ ...fileScope, event_types: designTypes }); await engine.tick();
  advance(); edit(d => { d.document.children[0].children[0].name = 'Already changed'; });
  const newSub = await engine.subscribe({ ...section, event_types: designTypes });
  await engine.tick(); assert.equal(engine.read(newSub.id).events.length, 0);
  advance(); edit(d => { d.document.children[0].children[0].name = 'New change'; }); await engine.tick();
  assert.equal(engine.read(newSub.id).events.length, 1);
});

test('failed design reads preserve snapshots, report partial coverage and do not invent deletion events', async t => {
  const advance = timing(t);
  const { engine, figma, edit, store } = await designFixture(t);
  const sub = await engine.subscribe(section); await engine.tick();
  const version = store.state.designs.fileA.version;
  advance(); edit(d => { d.document.children = []; });
  figma.file = async () => { throw new FigmaError('Figma HTTP 403', 403); };
  await assert.rejects(engine.tick(), /403/);
  assert.equal(store.state.designs.fileA.version, version);
  assert.equal(engine.read(sub.id).events.length, 0);
  assert.match(engine.subscription(sub.id).coverage.last_error, /403/);
  assert.equal(engine.subscription(sub.id).coverage.complete, false);
});

test('Figma URL scopes normalize to stable IDs and event type lists are canonical', () => {
  const direct = subscriptionSchema.parse({ ...section, event_types: ['figma.design.changed', 'figma.comment.edited'] });
  const url = subscriptionSchema.parse({ scope: { kind: 'section', url: 'https://www.figma.com/design/fileA/Design?node-id=2-1' },
    event_types: ['figma.comment.edited', 'figma.design.changed', 'figma.design.changed'] });
  assert.deepEqual(url, direct);
  assert.throws(() => subscriptionSchema.parse({ scope: { kind: 'section', url: 'https://example.com/design/fileA?node-id=2-1' } }));
  assert.throws(() => subscriptionSchema.parse({ scope: { kind: 'page', url: 'https://figma.com/design/fileA' } }));
  assert.throws(() => subscriptionSchema.parse({ ...fileScope, event_types: [] }));
});

test('comments-only selection avoids metadata/design fetches; reaction fallback checks current scope after design moves', async t => {
  const advance = timing(t);
  const { engine, figma, edit, counts } = await designFixture(t);
  const comments = await engine.subscribe({ ...fileScope, event_types: ['figma.comment.edited'] });
  figma.snapshots.set('fileA', [old('root', '#bot', { client_meta: { node_id: '4:1' }, reactions: undefined })]);
  await engine.tick(); assert.deepEqual(counts(), { fetches: 0, metadataCalls: 0 });
  advance();
  const reactions = await engine.subscribe({ ...section, event_types: ['figma.reaction.added'] });
  let items = [];
  figma.reactions = async () => items;
  await engine.tick();
  advance(); edit(d => { const [a,b] = d.document.children[0].children; b.children.push(a.children.pop()); });
  items = [reaction(':heart:')]; await engine.tick();
  assert.equal(engine.read(reactions.id).events.length, 0, 'reaction outside the section is excluded even when comment text is unchanged');
  assert.equal(engine.read(comments.id).events.length, 0);
});

test('large design deltas report truncation and original count explicitly', async t => {
  const advance = timing(t);
  const { engine, edit } = await designFixture(t);
  const sub = await engine.subscribe({ ...section, event_types: ['figma.design.changed'] }); await engine.tick();
  advance(); edit(d => {
    d.document.children[0].children[0].children.push(...Array.from({ length: 1005 }, (_, i) => ({ id: `new:${i}`, type: 'RECTANGLE' })));
  }); await engine.tick();
  const data = engine.read(sub.id).events[0].data;
  assert.equal(data.changes.length, 1000);
  assert.equal(data.total_changes, 1006);
  assert.equal(data.changes_truncated, true);
});

test('v1.1 state migration preserves old comment-only subscriptions and baselines new snapshot fields', async t => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { engine, directory, store, figma } = await fixture(t);
  const sub = await engine.subscribe({ ...fileScope, event_types: ['figma.comment.created'] }); await engine.close();
  const legacy = structuredClone(store.state);
  delete legacy.comments; delete legacy.designs; delete legacy.reactions; delete legacy.pendingDesigns;
  delete legacy.subscriptions[0].arguments.event_types;
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
  const migrated = new StateStore(directory); await migrated.open('user');
  const resumed = new WatchEngine(migrated, figma);
  assert.deepEqual(resumed.subscription(sub.id).arguments.event_types, ['figma.comment.created']);
  assert.deepEqual(migrated.state.pendingDesigns, {});
  await resumed.tick(); await resumed.close();
});

test('live-style stale metadata cannot hide a newer document version', async t => {
  const { FigmaClient } = await import('../dist/figma.js');
  const advance = timing(t);
  const { engine, figma } = await fixture(t, { designQuietPeriodMs: 0 });
  const file = await figma.file();
  const paths = [];
  const client = new FigmaClient('test', { requestIntervalMs: 0, fetch: async url => {
    paths.push(url.pathname + url.search);
    const response = url.pathname.endsWith('/meta') ? { file: { name: file.name, version: '1' } } : file;
    return new Response(JSON.stringify(response));
  } });
  t.after(() => client.close());
  figma.metadata = key => client.metadata(key);
  figma.file = key => client.file(key);
  const sub = await engine.subscribe({ ...fileScope, event_types: ['figma.design.changed'] });
  await engine.tick();
  advance(); file.version = '2'; file.document.children[0].children[0].name = 'Renamed';
  await engine.tick();
  const events = engine.read(sub.id).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].data.version, '2');
  assert.deepEqual(events[0].data.changes.find(c => c.node_id === '2:1').changed_properties, ['name']);
  assert.equal(paths.some(path => path.endsWith('/meta')), false);
});

test('default 120-second quiet window batches mutable-version edits; other scopes and comments do not reset it', async t => {
  timing(t);
  const { engine, doc, figma } = await designFixture(t, {});
  const sub = await engine.subscribe({ ...section, event_types: ['figma.design.changed', 'figma.comment.created'] });
  const all = await engine.subscribe({ ...fileScope, event_types: ['figma.design.changed'] });
  await engine.tick();
  t.mock.timers.tick(1000);
  doc().document.children[0].children[0].children[0].children[0].characters = 'First edit';
  await engine.tick();
  assert.equal(engine.read(sub.id).events.length, 0);
  t.mock.timers.tick(60000);
  doc().document.children[0].children[0].children[0].children[0].characters = 'Final edit';
  await engine.tick();
  t.mock.timers.tick(119999);
  doc().document.children[1].name = 'Unrelated page';
  figma.snapshots.set('fileA', [comment('new', 'Review', { client_meta: { node_id: '4:1' } })]);
  await engine.tick();
  const before = engine.read(sub.id);
  assert.deepEqual(names(before), ['figma.comment.created']);
  assert.equal(engine.read(all.id).events.length, 0);
  t.mock.timers.tick(1);
  await engine.tick();
  const batch = engine.read(sub.id, before.cursor);
  assert.deepEqual(names(batch), ['figma.design.changed']);
  const data = batch.events[0].data;
  assert.equal(data.version, data.previous_version, 'same version ID still produces an edit');
  assert.equal(data.quiet_period_ms, 120000);
  assert.deepEqual(data.changes.map(c => c.node_id), ['4:1']);
  assert.deepEqual(data.changes[0].changed_properties, ['characters']);
  assert.equal('subscriptionId' in batch.events[0], false, 'internal recipient is not exposed');
  assert.deepEqual(eventPayloadSchema.parse(data), data);
  assert.equal(engine.read(all.id).events.length, 0, 'file subscription has its own later deadline');
  t.mock.timers.tick(120000); await engine.tick();
  assert.equal(engine.read(all.id).events.length, 1);
  assert.equal(engine.read(sub.id, batch.cursor).events.length, 0, 'overlapping subscriptions do not duplicate delivery');
});

test('version-only changes and fully reverted edits do not produce changesets', async t => {
  timing(t);
  const { engine, doc } = await designFixture(t, {});
  const sub = await engine.subscribe({ ...fileScope, event_types: designTypes }); await engine.tick();
  t.mock.timers.tick(1000); doc().version = '2'; await engine.tick();
  assert.equal(engine.pollingStatus().pending_design_changesets.length, 0);
  const original = structuredClone(doc().document);
  doc().document.children[0].children[0].children.push({ id: 'new:1', type: 'RECTANGLE' });
  doc().document.children[0].children[0].name = 'Temporary'; await engine.tick();
  t.mock.timers.tick(60000); doc().document = original; await engine.tick();
  t.mock.timers.tick(120000); await engine.tick();
  assert.equal(engine.read(sub.id).events.length, 0);
  assert.equal(engine.pollingStatus().pending_design_changesets.length, 0);
});

test('pending changesets survive restart and require a successful read before flushing after failures', async t => {
  timing(t);
  const { engine, doc, figma, directory, store } = await designFixture(t, {});
  const sub = await engine.subscribe({ ...section, event_types: designTypes }); await engine.tick();
  t.mock.timers.tick(1000); doc().document.children[0].children[0].name = 'Changed'; await engine.tick();
  await engine.close();
  const reopened = new StateStore(directory); await reopened.open('user');
  const resumed = new WatchEngine(reopened, figma); t.after(() => resumed.close());
  assert.equal(resumed.pollingStatus().pending_design_changesets.length, 1);
  t.mock.timers.tick(120000);
  const readFile = figma.file;
  figma.file = async () => { throw new FigmaError('Figma HTTP 503', 503); };
  await assert.rejects(resumed.tick(), /503/);
  assert.equal(resumed.read(sub.id).events.length, 0);
  assert.equal(Object.keys(reopened.state.pendingDesigns).length, 1);
  figma.file = readFile; t.mock.timers.tick(10000); await resumed.tick();
  const batch = resumed.read(sub.id);
  assert.deepEqual(names(batch), ['figma.design.changed']);
  assert.equal(batch.events[0].data.changes[0].before.name, 'Payment');
  assert.equal(batch.events[0].data.changes[0].after.name, 'Changed');
  await resumed.tick(); assert.equal(resumed.read(sub.id, batch.cursor).events.length, 0);
  assert.equal(store.state.events.length, 0, 'nothing was emitted before restart');
  await resumed.close();
});

test('net scope movement and deletion wait for quiet; a restored target cancels transient deletion', async t => {
  timing(t);
  const { engine, doc } = await designFixture(t, {});
  const sub = await engine.subscribe({ ...section, event_types: designTypes }); await engine.tick();
  t.mock.timers.tick(1000);
  const [a,b] = doc().document.children[0].children;
  b.children.push(a.children.pop()); await engine.tick();
  t.mock.timers.tick(120000); await engine.tick();
  let batch = engine.read(sub.id);
  assert.equal(batch.events[0].data.changes.find(c => c.node_id === '3:1').kind, 'left');
  t.mock.timers.tick(1000);
  doc().document.children[0].children.shift(); await engine.tick();
  assert.equal(engine.subscription(sub.id).coverage.target_status, 'missing');
  assert.equal(engine.read(sub.id, batch.cursor).events.length, 0);
  t.mock.timers.tick(60000); doc().document.children[0].children.unshift(a); await engine.tick();
  t.mock.timers.tick(120000); await engine.tick();
  assert.equal(engine.read(sub.id, batch.cursor).events.length, 0);
  t.mock.timers.tick(1000); doc().document.children[0].children.shift(); await engine.tick();
  t.mock.timers.tick(120000); await engine.tick();
  batch = engine.read(sub.id, batch.cursor);
  assert.deepEqual(names(batch), ['figma.design.changed', 'figma.scope.deleted']);
});

test('a new overlapping subscriber baselines independently while an older changeset is pending', async t => {
  timing(t);
  const { engine, doc } = await designFixture(t, {});
  const first = await engine.subscribe({ ...section, event_types: designTypes }); await engine.tick();
  t.mock.timers.tick(1000); doc().document.children[0].children[0].name = 'Earlier edit'; await engine.tick();
  t.mock.timers.tick(1000);
  const second = await engine.subscribe({ ...section, event_types: ['figma.design.changed'], tag: '#bot' });
  await engine.tick();
  t.mock.timers.tick(120000); await engine.tick();
  assert.equal(engine.read(first.id).events.length, 1);
  assert.equal(engine.read(second.id).events.length, 0);
  t.mock.timers.tick(1000); doc().document.children[0].children[0].name = 'Later edit'; await engine.tick();
  await engine.unsubscribe(first.id);
  assert.equal(engine.pollingStatus().pending_design_changesets.length, 1, 'unsubscription discards its pending batch');
  t.mock.timers.tick(120000); await engine.tick();
  const batch = engine.read(second.id);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].data.changes[0].before.name, 'Earlier edit');
});

test('folder scope waits for quiet across all its files and fresh successful snapshots', async t => {
  timing(t);
  const { engine, doc, figma } = await designFixture(t, {});
  const a = doc(), b = structuredClone(a);
  figma.discovered.push({ key: 'fileB', name: 'Other file' });
  let failB = false;
  figma.file = async key => {
    if (key === 'fileB' && failB) throw new FigmaError('Figma HTTP 503', 503);
    return structuredClone(key === 'fileB' ? b : a);
  };
  const sub = await engine.subscribe({ scope: { kind: 'folder', folder_id: 'folder' }, event_types: ['figma.design.changed'] });
  await engine.tick();
  t.mock.timers.tick(1000); a.document.children[0].name = 'File A edit'; await engine.tick();
  t.mock.timers.tick(60000); b.document.children[0].name = 'File B edit'; await engine.tick();
  t.mock.timers.tick(60000); await engine.tick(); assert.equal(engine.read(sub.id).events.length, 0);
  t.mock.timers.tick(60000); failB = true;
  await assert.rejects(engine.tick(), /503/); assert.equal(engine.read(sub.id).events.length, 0);
  failB = false; t.mock.timers.tick(10000); await engine.tick();
  assert.deepEqual(engine.read(sub.id).events.map(e => e.data.file_key).sort(), ['fileA', 'fileB']);
});

test('file renames batch without node changes and do not delay scoped design batches', async t => {
  timing(t);
  const { engine, doc } = await designFixture(t, {});
  const all = await engine.subscribe({ ...fileScope, event_types: ['figma.design.changed'] });
  const scoped = await engine.subscribe({ ...section, event_types: ['figma.design.changed'] }); await engine.tick();
  t.mock.timers.tick(1000); doc().name = 'Renamed file'; await engine.tick();
  assert.equal(engine.pollingStatus().pending_design_changesets.length, 1);
  t.mock.timers.tick(120000); await engine.tick();
  const data = engine.read(all.id).events[0].data;
  assert.equal(data.metadata_changed, true);
  assert.deepEqual(data.changes, []);
  assert.equal(data.file_name, 'Renamed file');
  assert.equal(engine.read(scoped.id).events.length, 0);
});
