import { z } from 'zod';
import { redactOutboundText } from '../ai/redaction';
import type { PersistentGraphNode } from '../graph/model';
import { isBrainPath } from './policy';

export interface BrainFile {
  path: string;
  stale: boolean;
  notes: {
    id: string;
    text: string;
    startLine: number;
    endLine: number;
    revision: string;
    stale: boolean;
  }[];
}
export interface BrainContext {
  projectId: string;
  revision: string | null;
  files: BrainFile[];
  limitations: string[];
}
export interface ContextDependencies {
  latest(projectId: string): Promise<string | null>;
  search(
    projectId: string,
    revision: string,
    query: string
  ): Promise<{ path: string; stale: boolean }[]>;
  notes(projectId: string, revision: string, path: string): Promise<PersistentGraphNode[]>;
  changed(projectId: string, revision: string): Promise<boolean>;
}
const request = z.strictObject({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  task: z.string().trim().min(1).max(8000),
  paths: z.array(z.string().refine(isBrainPath)).max(200),
});
/** Local retrieval only. A model cannot add paths, choose a project, or traverse the filesystem. */
export async function retrieveBrainContext(
  projectId: string,
  task: string,
  allowedPaths: string[],
  deps: ContextDependencies
): Promise<BrainContext> {
  request.parse({ projectId, task, paths: allowedPaths });
  const revision = await deps.latest(projectId);
  const result: BrainContext = {
    projectId,
    revision,
    files: [],
    limitations: [
      'Bounded graph snapshot; indexed paths are evidence, not proof of current file contents. Do not search other projects. Request missing context explicitly.',
    ],
  };
  if (!revision) {
    result.limitations.push('No indexed graph. Run a local project audit first.');
    return result;
  }
  const explicit = [...task.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g)]
    .map((match) => match[0])
    .filter(isBrainPath);
  const terms = [
    ...new Set(explicit.length ? explicit : (task.match(/[A-Za-z0-9_.-]{3,80}/g) ?? [])),
  ].slice(0, 6);
  const allowed = new Set(allowedPaths);
  const candidates = new Map<string, boolean>();
  for (const term of terms) {
    for (const item of (await deps.search(projectId, revision, term)).slice(0, 50)) {
      if (
        isBrainPath(item.path) &&
        allowed.has(item.path) &&
        (!explicit.length || explicit.includes(item.path))
      )
        candidates.set(item.path, item.stale);
    }
  }
  const changed = await deps.changed(projectId, revision);
  for (const [path, stale] of [...candidates].slice(0, 12)) {
    const nodes = await deps.notes(projectId, revision, path);
    if (nodes.some((node) => node.projectId !== projectId || node.source?.path !== path))
      throw new Error('Graph note project/path scope mismatch.');
    const notes = nodes
      .filter((node) => node.extractionMethod === 'user-recorded')
      .slice(0, 12)
      .map((node) => ({
        id: node.id,
        text: redactOutboundText(node.label).slice(0, 1024),
        startLine: node.source!.startLine,
        endLine: node.source!.endLine,
        revision: node.revision,
        stale: changed || node.stale || node.revision !== revision,
      }));
    result.files.push({ path, stale: changed || stale, notes });
  }
  if (changed)
    result.limitations.push(
      'Changes or unknown watcher state make this context stale. Wait for refresh or capture another audit.'
    );
  if (!result.files.length)
    result.limitations.push(
      'No approved indexed path matched. Ask the user to approve the specific path; do not guess.'
    );
  if (candidates.size > 12)
    result.limitations.push('Only the first 12 matching paths are returned.');
  return result;
}
