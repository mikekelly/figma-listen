import type { Comment, FileNode, FileDocument, FileReference, Reaction, SubscriptionArguments } from './schema.js';
import { randomUUID } from 'node:crypto';
import { ResourceQueue } from './queue.js';

export class FigmaError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs = 0,
    /** Scopes Figma reported for the token when it rejected a request for missing scope. */
    public readonly grantedScopes?: string[]) {
    super(message); this.name = 'FigmaError';
  }
}
export interface NewComment {
  message: string; comment_id?: string;
  client_meta?: { node_id: string; node_offset: { x: number; y: number } };
}
export interface FigmaSource {
  readonly requestIntervalMs?: number;
  requestStatus?(): ReturnType<ResourceQueue['status']>;
  me(): Promise<{ id: string; handle?: string }>;
  comments(key: string): Promise<Comment[]>;
  file(key: string): Promise<FileDocument>;
  metadata(key: string): Promise<{ name: string; version: string }>;
  reactions(key: string, commentId: string): Promise<Reaction[]>;
  discover(scope: SubscriptionArguments['scope']): Promise<{ files: FileReference[]; warnings: string[] }>;
  postComment?(key: string, comment: NewComment): Promise<Comment>;
}

/** Figma's 403 for a missing scope lists the scopes the token does have. Keep only that list. */
function grantedScopes(body: string): string[] | undefined {
  let message: unknown;
  try { message = JSON.parse(body)?.message; } catch { return undefined; }
  const match = typeof message === 'string' && message.match(/Invalid scopes?: (\[[^\]]*\])/);
  if (!match) return undefined;
  try {
    const scopes: unknown = JSON.parse(match[1]);
    if (Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string' && /^[a-z_]+(:[a-z_]+)?$/.test(scope))) return scopes;
  } catch { /* An unrecognized message is not a scope report. */ }
  return undefined;
}

/** Request starts are paced; slow responses do not serialize other requests. */
export class FigmaClient implements FigmaSource {
  private requests: ResourceQueue;
  private controller = new AbortController();
  constructor(private readonly token: string, private readonly options: {
    baseUrl?: string; fetch?: typeof fetch; requestIntervalMs?: number; timeoutMs?: number; maxConcurrentRequests?: number;
  } = {}) {
    this.requests = new ResourceQueue({ startIntervalMs: this.requestIntervalMs,
      maxConcurrent: options.maxConcurrentRequests ?? 4 });
  }
  get requestIntervalMs(): number { return this.options.requestIntervalMs ?? 2000; }
  requestStatus(): ReturnType<ResourceQueue['status']> { return this.requests.status(); }
  close(): void { this.controller.abort(); void this.requests.close(); }
  get<T>(path: string): Promise<T> { return this.request('GET', path); }
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, paced = true): Promise<T> {
    const base = this.options.baseUrl ?? 'https://api.figma.com';
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin) throw new Error('Refusing a cross-origin API URL');
    const send = async (): Promise<T> => {
      if (this.controller.signal.aborted) throw new Error('Figma client closed');
      const response = await (this.options.fetch ?? fetch)(url, {
        method, headers: { 'X-Figma-Token': this.token, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]),
      });
      if (!response.ok) {
        const raw = response.headers.get('retry-after');
        const retry = raw ? (Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 60000;
        const backoff = response.status === 429 ? Math.max(1000, Number.isFinite(retry) ? retry : 60000) : 0;
        if (backoff) this.requests.pause(backoff);
        const scopes = response.status === 403 ? grantedScopes((await response.text().catch(() => '')).slice(0, 10000)) : undefined;
        const hint = scopes ? 'Token is missing a scope this endpoint requires.'
          : response.status === 401 || response.status === 403
          ? 'Token invalid/expired, missing scope, or resource access denied.'
          : response.status === 429 ? 'Rate limited; respecting Retry-After.'
          : response.status === 404 ? 'Resource not found or inaccessible.' : 'Upstream request failed.';
        // Never include a response body, token, or request headers in an error.
        throw new FigmaError(`Figma HTTP ${response.status}. ${hint}`, response.status, backoff, scopes);
      }
      return await response.json() as T;
    };
    if (!paced) return send();
    // Writes are never coalesced with another request for the same URL.
    return this.requests.enqueue(method === 'GET' ? url.href : `${method} ${url.href} ${randomUUID()}`, send);
  }
  /**
   * Figma has no scope introspection. Probe endpoints that need scopes a typical
   * token lacks: the rejection lists the granted scopes, and neither probe can
   * write anything. Null means no probe was rejected for scope, so it's unknown.
   */
  async scopes(): Promise<string[] | null> {
    const probes = [() => this.request('GET', '/v2/webhooks', undefined, false),
      () => this.request('POST', '/v1/dev_resources', {}, false)];
    for (const probe of probes) {
      try { await probe(); } catch (error) {
        if (error instanceof FigmaError && error.grantedScopes) return error.grantedScopes;
      }
    }
    return null;
  }
  me(): Promise<{ id: string; handle?: string }> { return this.get('/v1/me'); }
  async comments(key: string): Promise<Comment[]> {
    const response = await this.get<{ comments: Comment[] }>(`/v1/files/${encodeURIComponent(key)}/comments`);
    if (!Array.isArray(response.comments)) throw new Error('Figma returned an invalid comments response');
    for (const comment of response.comments) {
      if (typeof comment.id !== 'string' || typeof comment.message !== 'string' ||
          !Number.isFinite(Date.parse(comment.created_at)) || typeof comment.user?.id !== 'string') {
        throw new Error('Figma returned an invalid comment');
      }
    }
    if (response.comments.length > 100000) throw new Error('Comment snapshot limit (100000) exceeded');
    return response.comments;
  }
  async postComment(key: string, comment: NewComment): Promise<Comment> {
    const result = await this.request<Comment>('POST', `/v1/files/${encodeURIComponent(key)}/comments`, comment);
    if (typeof result?.id !== 'string' || typeof result.created_at !== 'string')
      throw new Error('Figma returned an invalid comment');
    return result;
  }
  async file(key: string): Promise<FileDocument> {
    const file = await this.get<FileDocument>(`/v1/files/${encodeURIComponent(key)}?geometry=paths`);
    if (!file.document || typeof file.name !== 'string' || typeof file.version !== 'string')
      throw new Error('Figma returned an invalid file response');
    return file;
  }
  async metadata(key: string): Promise<{ name: string; version: string }> {
    // /meta can lag behind edits already visible in GET file. Read the version
    // from the document endpoint, with a shallow tree to keep the payload small.
    const result = await this.get<{ name: string; version: string }>(`/v1/files/${encodeURIComponent(key)}?depth=1`);
    if (typeof result.version !== 'string' || typeof result.name !== 'string')
      throw new Error('Figma returned invalid file metadata');
    return { name: result.name, version: result.version };
  }
  async reactions(key: string, commentId: string): Promise<Reaction[]> {
    const result: Reaction[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const path = `/v1/files/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}/reactions`;
      const page = await this.get<{ reactions: Reaction[]; pagination?: { next_page?: string | null } }>(
        path + (cursor ? `?${new URLSearchParams({ cursor })}` : ''));
      if (!Array.isArray(page.reactions)) throw new Error('Figma returned invalid reactions');
      result.push(...page.reactions);
      cursor = page.pagination?.next_page || undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Reaction pagination limit or repeated cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }
  private async folders(path: string): Promise<{ id: string; name?: string }[]> {
    const result = await this.get<{ folders: { id: string; name?: string }[] }>(path);
    if (!Array.isArray(result.folders)) throw new Error('Figma returned an invalid folders response');
    return result.folders;
  }
  async discover(scope: SubscriptionArguments['scope']): Promise<{ files: FileReference[]; warnings: string[] }> {
    if ('file_key' in scope) return { files: [{ key: scope.file_key }], warnings: [] };
    const files = new Map<string, FileReference>();
    const visited = new Set<string>();
    const warnings: string[] = [];
    const visit = async (folderId: string, recursive: boolean): Promise<void> => {
      if (visited.has(folderId)) return;
      if (visited.size >= 1000) throw new Error('Folder discovery limit (1000) exceeded; narrow the scope');
      visited.add(folderId);
      try {
        const response = await this.get<{ files: FileReference[] }>(`/v2/folders/${encodeURIComponent(folderId)}/files`);
        if (!Array.isArray(response.files)) throw new Error('Figma returned an invalid folder files response');
        for (const file of response.files) files.set(file.key, file);
        if (recursive) for (const folder of await this.folders(`/v2/folders/${encodeURIComponent(folderId)}/folders`))
          await visit(folder.id, true);
      } catch (error) {
        if (error instanceof FigmaError && (error.status === 429 || error.status >= 500)) throw error;
        warnings.push(`Folder ${folderId}: ${error instanceof Error ? error.message : 'discovery failed'}`);
      }
    };
    if (scope.kind === 'folder') await visit(scope.folder_id, scope.recursive);
    else {
      const teams = scope.kind === 'team' ? [scope.team_id] : scope.team_ids;
      if (scope.kind === 'organization') warnings.push(
        'Organization coverage is limited to supplied team IDs. Team affiliation and undisclosed teams cannot be verified by this API.');
      for (const team of teams) {
        try { for (const folder of await this.folders(`/v2/teams/${encodeURIComponent(team)}/folders`)) await visit(folder.id, true); }
        catch (error) {
          if (error instanceof FigmaError && (error.status === 429 || error.status >= 500)) throw error;
          warnings.push(`Team ${team}: ${error instanceof Error ? error.message : 'discovery failed'}`);
        }
      }
    }
    if (files.size > 500) throw new Error('File discovery limit (500) exceeded; narrow the scope');
    warnings.push('Discovery includes only resources visible to the authenticated account; drafts and unlisted files may be outside this scope.');
    return { files: [...files.values()], warnings };
  }
}

export interface Anchor { pageId: string | null; ancestors: string[] }
export function indexNodes(document: FileNode): Map<string, Anchor> {
  const index = new Map<string, Anchor>();
  const visit = (node: FileNode, pageId: string | null, ancestors: string[]) => {
    if (!node || typeof node.id !== 'string' || typeof node.type !== 'string' || index.has(node.id))
      throw new Error('Figma returned an invalid or duplicate document node');
    if (index.size >= 100000 || ancestors.length > 200) throw new Error('Document index limit exceeded (100000 nodes / 200 levels)');
    const page = node.type === 'CANVAS' ? node.id : pageId;
    index.set(node.id, { pageId: page, ancestors });
    for (const child of node.children ?? []) visit(child, page, [...ancestors, node.id]);
  };
  visit(document, null, []);
  return index;
}
