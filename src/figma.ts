import type { Comment, FileNode, FileReference, SubscriptionArguments } from './schema.js';
import { ResourceQueue } from './queue.js';

export class FigmaError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs = 0) {
    super(message); this.name = 'FigmaError';
  }
}
export interface FigmaSource {
  readonly requestIntervalMs?: number;
  requestStatus?(): ReturnType<ResourceQueue['status']>;
  me(): Promise<{ id: string; handle?: string }>;
  comments(key: string): Promise<Comment[]>;
  file(key: string): Promise<{ name: string; document: FileNode }>;
  discover(scope: SubscriptionArguments['scope']): Promise<{ files: FileReference[]; warnings: string[] }>;
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
  async get<T>(path: string): Promise<T> {
    const base = this.options.baseUrl ?? 'https://api.figma.com';
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin) throw new Error('Refusing a cross-origin API URL');
    return this.requests.enqueue(url.href, async () => {
      if (this.controller.signal.aborted) throw new Error('Figma client closed');
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: { 'X-Figma-Token': this.token, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]),
      });
      if (!response.ok) {
        const raw = response.headers.get('retry-after');
        const retry = raw ? (Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 60000;
        const backoff = response.status === 429 ? Math.max(1000, Number.isFinite(retry) ? retry : 60000) : 0;
        if (backoff) this.requests.pause(backoff);
        const hint = response.status === 401 || response.status === 403
          ? 'Token invalid/expired, missing scope, or resource access denied.'
          : response.status === 429 ? 'Rate limited; respecting Retry-After.'
          : response.status === 404 ? 'Resource not found or inaccessible.' : 'Upstream request failed.';
        // Never include a response body, token, or request headers in an error.
        throw new FigmaError(`Figma HTTP ${response.status}. ${hint}`, response.status, backoff);
      }
      return await response.json() as T;
    });
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
    return response.comments;
  }
  file(key: string): Promise<{ name: string; document: FileNode }> {
    return this.get(`/v1/files/${encodeURIComponent(key)}`);
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
    const page = node.type === 'CANVAS' ? node.id : pageId;
    index.set(node.id, { pageId: page, ancestors });
    for (const child of node.children ?? []) visit(child, page, [...ancestors, node.id]);
  };
  visit(document, null, []);
  return index;
}
