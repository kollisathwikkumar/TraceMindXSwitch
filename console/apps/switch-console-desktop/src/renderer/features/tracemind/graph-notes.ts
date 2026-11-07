import type { GraphInspection } from '@main/core/tracemind/graph/graph-query';
import type { PersistentGraphNode } from '@main/core/tracemind/graph/model';

/** Display-only filter. Users can reveal these files; stored evidence is never removed. */
export function isGraphSourcePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return (
    !/(^|\/)(node_modules|\.git|\.unlazy|dist|out|build|release|coverage|output|playwright-report|test-results|diff_files|\.playwright-cli|\.cache)(\/|$)/.test(
      normalized
    ) &&
    !/(^|\/)(\.ds_store|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(
      normalized
    ) &&
    !/(^|\/)[^/]*(?:[-_]rollback[-_]test|[-_]coverage[-_]baseline)(\/|$)/.test(normalized) &&
    !/(^|\/)(?:baseline|modified_snapshot)(\/|$)/.test(normalized) &&
    !/(^|\/)(?:baseline_file|modified_file|diff_file|verification\.txt|rollback\.sh)$/.test(
      normalized
    ) &&
    !/\.(map|modified-save|log|bak|tsbuildinfo|diff|patch|png|jpe?g|webp|gif|ico|mp4|mov|mp3|wav|zip|gz|pdf)$/.test(
      normalized
    )
  );
}

/** Filter geometry and details together so hidden files never leave dangling edges. */
export function sourceGraphInspection(
  inspection: GraphInspection | null,
  showAuxiliary: boolean
): GraphInspection | null {
  if (!inspection || showAuxiliary) return inspection;
  const nodes = inspection.nodes.filter((node) => {
    const path = node.source?.path ?? (node.kind === 'file' ? node.label : null);
    return !path || isGraphSourcePath(path);
  });
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...inspection,
    nodes,
    relationships: inspection.relationships.filter(
      (edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)
    ),
  };
}

/** Rank only actual adjacent records, never visual proximity or name similarity. */
export function connectionNotes(
  inspection: GraphInspection | null,
  selectedId: string
): PersistentGraphNode[] {
  if (!inspection || !selectedId) return [];
  const scores = new Map<string, number>();
  for (const edge of inspection.relationships) {
    const other =
      edge.sourceId === selectedId
        ? edge.targetId
        : edge.targetId === selectedId
          ? edge.sourceId
          : null;
    if (!other || other === selectedId) continue;
    const weight = edge.stale
      ? 0
      : edge.certainty === 'direct'
        ? 3
        : edge.certainty === 'heuristic'
          ? 2
          : 1;
    scores.set(other, Math.max(scores.get(other) ?? -1, weight));
  }
  return inspection.nodes
    .filter((node) => scores.has(node.id))
    .sort(
      (a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id)
    );
}

/** Stable, connection-led layout. Only saved edges attract nodes; z remains zero. */
export function connectionPositions(
  inspection: GraphInspection
): Map<string, { x: number; y: number; z: number }> {
  const nodes = [...inspection.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const points = new Map(
    nodes.map((node, i) => [
      node.id,
      {
        x: Math.cos(i * 2.39996) * (50 + 20 * Math.sqrt(i)),
        y: Math.sin(i * 2.39996) * (50 + 20 * Math.sqrt(i)),
        z: 0,
      },
    ])
  );
  // The canvas is paged to 80 selected nodes. Root previews are bounded by retrieval.
  // Bound iterations too; this is visual layout, never a new evidence relationship.
  for (let pass = 0; pass < 60; pass++) {
    const delta = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = points.get(nodes[i].id)!;
        const b = points.get(nodes[j].id)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(16, Math.hypot(dx, dy));
        const force = 1800 / (distance * distance);
        delta.get(nodes[i].id)!.x += dx * force;
        delta.get(nodes[i].id)!.y += dy * force;
        delta.get(nodes[j].id)!.x -= dx * force;
        delta.get(nodes[j].id)!.y -= dy * force;
      }
    }
    for (const edge of inspection.relationships) {
      const a = points.get(edge.sourceId);
      const b = points.get(edge.targetId);
      if (!a || !b || edge.sourceId === edge.targetId) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const force = (Math.hypot(dx, dy) - 100) * 0.0007;
      delta.get(edge.sourceId)!.x += dx * force;
      delta.get(edge.sourceId)!.y += dy * force;
      delta.get(edge.targetId)!.x -= dx * force;
      delta.get(edge.targetId)!.y -= dy * force;
    }
    for (const node of nodes) {
      const point = points.get(node.id)!;
      const change = delta.get(node.id)!;
      point.x = Math.max(
        -340,
        Math.min(340, point.x + Math.max(-8, Math.min(8, change.x)) - point.x * 0.005)
      );
      point.y = Math.max(
        -260,
        Math.min(260, point.y + Math.max(-8, Math.min(8, change.y)) - point.y * 0.005)
      );
    }
  }
  return points;
}
