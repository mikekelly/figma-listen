import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../dist/store.js';
import { WatchEngine } from '../dist/engine.js';

export const comment = (id, message, extra = {}) => ({ id, message,
  created_at: new Date(Date.now() + 1000).toISOString(), user: { id: 'user', handle: 'Designer' }, reactions: [], ...extra });
export const fileScope = { scope: { kind: 'file', file_key: 'fileA' } };
export class FakeFigma {
  snapshots = new Map([['fileA', []]]);
  discovered = [{ key: 'fileA', name: 'Design' }];
  calls = [];
  error;
  async me() { return { id: 'user' }; }
  async comments(key) { this.calls.push(key); if (this.error) throw this.error; return this.snapshots.get(key) ?? []; }
  async discover(scope) { return { files: 'file_key' in scope ? [{ key: scope.file_key }] : this.discovered, warnings: [] }; }
  async metadata() { return { name: 'Design', version: '1' }; }
  async reactions() { return []; }
  posted = [];
  postError;
  /** Resolves once the comment exists upstream; `respond` controls when the POST response arrives. */
  respond = async () => {};
  async postComment(key, body) {
    if (this.postError) throw this.postError;
    const created = comment(`posted-${this.posted.length + 1}`, body.message,
      { ...(body.comment_id ? { parent_id: body.comment_id } : {}), ...(body.client_meta ? { client_meta: body.client_meta } : {}) });
    this.posted.push({ key, body });
    this.snapshots.set(key, [...(this.snapshots.get(key) ?? []), created]);
    await this.respond();
    return created;
  }
  async file() { return { name: 'Design', version: '1', document: { id: '0:0', type: 'DOCUMENT', children: [
    { id: '1:1', type: 'CANVAS', children: [{ id: '2:1', type: 'FRAME', children: [{ id: '3:1', type: 'TEXT' }] }] },
    { id: '1:2', type: 'CANVAS', children: [{ id: '4:1', type: 'TEXT' }] },
  ] } }; }
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-watch-test-'));
  const store = new StateStore(directory); await store.open('user');
  const figma = new FakeFigma();
  const engine = new WatchEngine(store, figma, options);
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, figma, engine };
}
