import * as z from 'zod/v4';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/);
const fileKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const nodeId = id.transform(value => value.replace(/-/g, ':'));
const explicitScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file_key: fileKey }).strict(),
  z.object({ kind: z.literal('page'), file_key: fileKey, page_id: nodeId }).strict(),
  z.object({ kind: z.literal('section'), file_key: fileKey, node_id: nodeId }).strict(),
  z.object({ kind: z.literal('frame'), file_key: fileKey, node_id: nodeId }).strict(),
  z.object({ kind: z.literal('folder'), folder_id: id, recursive: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('team'), team_id: id }).strict(),
  z.object({ kind: z.literal('organization'), organization_id: id,
    team_ids: z.array(id).min(1).max(100).transform(ids => [...new Set(ids)].sort()) }).strict(),
]);
const urlScope = z.object({ kind: z.enum(['file', 'page', 'section', 'frame']), url: z.string().url() }).strict()
  .transform((input, ctx) => {
    const url = new URL(input.url);
    const match = url.pathname.match(/^\/(?:design|file|board|slides)\/([A-Za-z0-9_-]+)(?:\/|$)/);
    const node = url.searchParams.get('node-id');
    if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname) || !match ||
        (input.kind !== 'file' && !node)) {
      ctx.issues.push({ code: 'custom', input, message: 'Use a Figma file URL; page/section/frame URLs need node-id.' });
      return z.NEVER;
    }
    return { kind: input.kind, file_key: match[1], ...(input.kind === 'page' ? { page_id: node } :
      input.kind !== 'file' ? { node_id: node } : {}) } as z.input<typeof explicitScope>;
  }).pipe(explicitScope);
export const scopeSchema = z.union([explicitScope, urlScope]);
export const eventNames = [
  'figma.comment.created', 'figma.comment.edited', 'figma.comment.deleted',
  'figma.comment.resolved', 'figma.comment.reopened',
  'figma.reaction.added', 'figma.reaction.removed',
  'figma.design.changed', 'figma.scope.deleted',
] as const;
export const eventName = eventNames[0];
export type EventName = typeof eventNames[number];
export const subscriptionSchema = z.object({
  scope: scopeSchema,
  event_types: z.array(z.enum(eventNames)).min(1).max(eventNames.length)
    .transform(names => [...new Set(names)].sort()).default([...eventNames].sort()),
  tag: z.string().min(2).max(100).regex(/^#[\p{L}\p{N}_-]+$/u).optional(),
  include_thread_replies: z.boolean().default(false),
}).strict();
export type SubscriptionArguments = z.infer<typeof subscriptionSchema>;
const authorSchema = z.object({ id: z.string(), handle: z.string().optional() }).strict();
export const reactionSchema = z.object({ user: authorSchema, emoji: z.string(), created_at: z.string() }).strict();
const locationSchema = z.object({ node_id: z.string().nullable(), page_id: z.string().nullable(),
  ancestor_ids: z.array(z.string()) }).strict();
export const commentPayloadSchema = z.object({
  file_key: z.string(), file_name: z.string().optional(), comment_id: z.string(),
  thread_id: z.string(), parent_id: z.string().nullable(), text: z.string(),
  author: authorSchema, created_at: z.string(), resolved_at: z.string().nullable(),
  ...locationSchema.shape, url: z.string(), thread_has_tag: z.array(z.string()),
  previous_text: z.string().optional(), previous_thread_has_tag: z.array(z.string()).optional(),
  previous_location: locationSchema.optional(), previous_resolved_at: z.string().nullable().optional(),
  reaction: reactionSchema.optional(),
}).strict();
const nodeInfoSchema = z.object({ ...locationSchema.shape, name: z.string(), type: z.string() }).strict();
export const designChangeSchema = z.object({
  kind: z.enum(['added', 'updated', 'removed', 'moved', 'entered', 'left']),
  node_id: z.string(), before: nodeInfoSchema.optional(), after: nodeInfoSchema.optional(),
  changed_properties: z.array(z.string()),
}).strict();
export const designPayloadSchema = z.object({
  file_key: z.string(), file_name: z.string(), url: z.string(),
  target_id: z.string().nullable(), version: z.string(), previous_version: z.string(),
  changes: z.array(designChangeSchema), total_changes: z.number(), changes_truncated: z.boolean(),
  metadata_changed: z.boolean(),
  first_observed_at: z.string().optional(), last_observed_at: z.string().optional(),
  quiet_period_ms: z.number().nonnegative().optional(),
}).strict();
export const eventPayloadSchema = z.union([commentPayloadSchema, designPayloadSchema]);
export type CommentData = z.infer<typeof commentPayloadSchema>;
export type DesignData = z.infer<typeof designPayloadSchema>;
export type DesignChange = z.infer<typeof designChangeSchema>;
export type EventData = z.infer<typeof eventPayloadSchema>;
export interface EventOccurrence {
  eventId: string; name: EventName; timestamp: string; data: EventData;
  sequence: number; observedAt: string;
  /** Existing snapshots predate a new subscription; don't replay pre-subscription differences. */
  since?: string;
  /** Batched designs belong to the subscription whose quiet timer produced them. */
  subscriptionId?: string;
}
export interface Reaction { user: { id: string; handle?: string }; emoji: string; created_at: string }
export interface Comment {
  id: string; message: string; parent_id?: string; created_at: string;
  resolved_at?: string | null; user: { id: string; handle?: string }; reactions?: Reaction[];
  client_meta?: { node_id?: string; [key: string]: unknown };
}
export interface FileReference { key: string; name?: string }
export interface FileNode { id: string; type: string; name?: string; children?: FileNode[]; [key: string]: unknown }
export interface FileDocument { name: string; version: string; document: FileNode }
export interface NodeSnapshot {
  info: z.infer<typeof nodeInfoSchema>;
  properties: Record<string, string>;
}
export interface DesignSnapshot {
  version: string; name: string; observedAt: string; nodes: Record<string, NodeSnapshot>;
}
export interface PendingDesign {
  firstChangedAt: string; lastChangedAt: string;
  files: Record<string, {
    version: string; name: string; since: string;
    /** Original values of touched nodes only; null means the node was added. */
    nodes: Record<string, NodeSnapshot | null>;
  }>;
}
export interface CommentSnapshot { observedAt: string; comments: Comment[]; data: Record<string, CommentData> }
export interface Coverage {
  file_keys: string[]; complete: boolean; warnings: string[]; excluded_unanchored_comments: number;
  last_success_at?: string; last_error?: string;
  resource_errors?: Record<string, string>;
  target_status?: 'present' | 'missing';
}
export interface Subscription {
  id: string; arguments: SubscriptionArguments; createdAt: string;
  startSequence: number; source: 'tool' | 'poll' | 'stream'; expiresAt?: string; coverage: Coverage;
}
export function targetId(scope: SubscriptionArguments['scope']): string | null {
  return scope.kind === 'page' ? scope.page_id : 'node_id' in scope ? scope.node_id : null;
}
export function isDesignEvent(name: EventName): boolean { return name === 'figma.design.changed' || name === 'figma.scope.deleted'; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function tagsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#[\p{L}\p{N}_-]+/gu)].map(m => m[0]))];
}
