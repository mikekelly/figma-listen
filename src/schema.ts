import * as z from 'zod/v4';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/);
const fileKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const nodeId = id.transform(value => value.replace(/-/g, ':'));
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file_key: fileKey }).strict(),
  z.object({ kind: z.literal('page'), file_key: fileKey, page_id: nodeId }).strict(),
  z.object({ kind: z.literal('frame'), file_key: fileKey, node_id: nodeId }).strict(),
  z.object({ kind: z.literal('folder'), folder_id: id, recursive: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('team'), team_id: id }).strict(),
  z.object({ kind: z.literal('organization'), organization_id: id,
    team_ids: z.array(id).min(1).max(100).transform(ids => [...new Set(ids)].sort()) }).strict(),
]);
export const subscriptionSchema = z.object({
  scope: scopeSchema,
  tag: z.string().min(2).max(100).regex(/^#[\p{L}\p{N}_-]+$/u).optional(),
  include_thread_replies: z.boolean().default(false),
}).strict();
export type SubscriptionArguments = z.infer<typeof subscriptionSchema>;
export const eventName = 'figma.comment.created';
export const eventPayloadSchema = z.object({
  file_key: z.string(), file_name: z.string().optional(), comment_id: z.string(),
  thread_id: z.string(), parent_id: z.string().nullable(), text: z.string(),
  author: z.object({ id: z.string(), handle: z.string().optional() }),
  created_at: z.string(), resolved_at: z.string().nullable(),
  node_id: z.string().nullable(), page_id: z.string().nullable(),
  ancestor_ids: z.array(z.string()), url: z.string(),
  thread_has_tag: z.array(z.string()),
}).strict();
export type EventData = z.infer<typeof eventPayloadSchema>;
export interface EventOccurrence {
  eventId: string;
  name: typeof eventName;
  timestamp: string;
  data: EventData;
  sequence: number;
  observedAt: string;
}
export interface Comment {
  id: string; message: string; parent_id?: string; created_at: string;
  resolved_at?: string | null; user: { id: string; handle?: string };
  client_meta?: { node_id?: string; [key: string]: unknown };
}
export interface FileReference { key: string; name?: string }
export interface FileNode { id: string; type: string; children?: FileNode[] }
export interface Coverage {
  file_keys: string[];
  complete: boolean;
  warnings: string[];
  excluded_unanchored_comments: number;
  last_success_at?: string;
  last_error?: string;
}
export interface Subscription {
  id: string; arguments: SubscriptionArguments; createdAt: string;
  startSequence: number; source: 'tool' | 'poll' | 'stream';
  expiresAt?: string;
  coverage: Coverage;
}

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
