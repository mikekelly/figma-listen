import { createHash } from 'node:crypto';
import { canonical, type DesignChange, type DesignSnapshot, type FileDocument, type FileNode, type NodeSnapshot } from './schema.js';

export function snapshot(file: FileDocument, observedAt: string): DesignSnapshot {
  const nodes: Record<string, NodeSnapshot> = Object.create(null);
  let count = 0;
  const visit = (node: FileNode, page: string | null, ancestors: string[]) => {
    if (!node || typeof node.id !== 'string' || typeof node.type !== 'string' || nodes[node.id])
      throw new Error('Figma returned an invalid or duplicate document node');
    if (++count > 100000 || ancestors.length > 200) throw new Error('Document snapshot limit exceeded (100000 nodes / 200 levels)');
    const pageId = node.type === 'CANVAS' ? node.id : page;
    const properties: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(node)) {
      // Hash values; persist property names and hashes, not the whole design document.
      const normalized = key === 'children' ? node.children?.map(child => child.id) : value;
      properties[key] = createHash('sha256').update(canonical(normalized)).digest('hex');
    }
    nodes[node.id] = { info: { node_id: node.id, page_id: pageId, ancestor_ids: ancestors,
      name: node.name ?? '', type: node.type }, properties };
    for (const child of node.children ?? []) visit(child, pageId, [...ancestors, node.id]);
  };
  visit(file.document, null, []);
  return { version: file.version, name: file.name, observedAt, nodes };
}
export function diffNodes(before: DesignSnapshot, after: DesignSnapshot): DesignChange[] {
  const changes: DesignChange[] = [];
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    const old = before.nodes[id], next = after.nodes[id];
    const properties = old && next ? [...new Set([...Object.keys(old.properties), ...Object.keys(next.properties)])]
      .filter(key => old.properties[key] !== next.properties[key]).sort() : [];
    const moved = old && next && canonical(old.info.ancestor_ids) !== canonical(next.info.ancestor_ids);
    if (old && next && !moved && !properties.length) continue;
    changes.push({ kind: !old ? 'added' : !next ? 'removed' : moved ? 'moved' : 'updated', node_id: id,
      ...(old ? { before: old.info } : {}), ...(next ? { after: next.info } : {}), changed_properties: properties });
  }
  return changes;
}
export function inTarget(info: NodeSnapshot['info'] | undefined, target: string): boolean {
  return !!info && (info.node_id === target || info.ancestor_ids.includes(target));
}
export function scopeChanges(changes: DesignChange[], target: string | null): DesignChange[] {
  if (!target) return changes;
  return changes.filter(change => inTarget(change.before, target) || inTarget(change.after, target)).map(change => {
    if (change.before && change.after) {
      if (!inTarget(change.before, target)) return { ...change, kind: 'entered' };
      if (!inTarget(change.after, target)) return { ...change, kind: 'left' };
    }
    return change;
  });
}
