import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getLocationById } from '@main/core/locations/store';
import { db } from '@main/db/client';
import { tracemindGraphRevisions, tracemindGraphNodes } from '@main/db/schema';
import { getGraphNode, searchGraphFiles } from '../graph/graph-store';
import { resolveSelectedLocalProject } from '../project-registry/selected-project';
import { retrieveBrainContext, type BrainContext } from './context';
import { isWatchedBrainRevision } from './freshness';

export async function getLocalBrainContext(
  projectId: string,
  task: string,
  allowedPaths: string[]
): Promise<BrainContext> {
  const project = await resolveSelectedLocalProject(projectId, getLocationById);
  const result = await retrieveBrainContext(projectId, task, allowedPaths, {
    latest: async (id) => {
      const row = db
        .select({ revision: tracemindGraphRevisions.revision })
        .from(tracemindGraphRevisions)
        .where(eq(tracemindGraphRevisions.projectId, id))
        .orderBy(desc(tracemindGraphRevisions.capturedAt), desc(tracemindGraphRevisions.revision))
        .limit(1)
        .get();
      return row?.revision ?? null;
    },
    search: async (id, revision, query) =>
      (await searchGraphFiles(id, revision, query, null))?.files ?? [],
    // Include historical manual notes, with their original revision and explicit staleness.
    notes: async (id, _revision, path) => {
      const rows = db
        .select({ id: tracemindGraphNodes.id, revision: tracemindGraphNodes.revision })
        .from(tracemindGraphNodes)
        .where(
          and(
            eq(tracemindGraphNodes.projectId, id),
            eq(tracemindGraphNodes.sourcePath, path),
            eq(
              sql<string>`json_extract(${tracemindGraphNodes.payload}, '$.extractionMethod')`,
              'user-recorded'
            )
          )
        )
        .orderBy(desc(tracemindGraphNodes.ordinal))
        .limit(200)
        .all();
      const notes = [];
      for (const row of rows) {
        const node = await getGraphNode(id, row.revision, row.id);
        if (node?.extractionMethod === 'user-recorded') notes.push(node);
        if (notes.length >= 12) break;
      }
      return notes;
    },
    changed: async (id, revision) => !isWatchedBrainRevision(id, revision),
  });
  const files = [];
  for (const file of result.files) {
    let path = project.root;
    let eligible = true;
    try {
      const parts = file.path.split('/');
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const entry = await lstat(path);
        if (
          entry.isSymbolicLink() ||
          (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())
        ) {
          eligible = false;
          break;
        }
      }
    } catch {
      eligible = false;
    }
    if (eligible) files.push(file);
  }
  if (files.length !== result.files.length)
    result.limitations.push(
      'Missing, non-file, or symlink paths were withheld at retrieval. Files can still change after this check.'
    );
  return { ...result, files };
}
