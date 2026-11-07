import { stat } from 'node:fs/promises';
import { getLocationById } from '@main/core/locations/store';
import { resolveSelectedLocalProject } from '../project-registry/selected-project';
import type { BrainPolicy } from './policy';
import { getBrainPolicy } from './store';

/** Revalidate the registry and filesystem identity before every use of a persisted grant. */
export async function getBoundBrainPolicy(projectId: string): Promise<BrainPolicy | null> {
  const policy = await getBrainPolicy(projectId);
  if (!policy) return null;
  const project = await resolveSelectedLocalProject(projectId, getLocationById);
  const info = await stat(project.root, { bigint: true });
  if (project.root !== policy.root || `${info.dev}:${info.ino}` !== policy.identity)
    throw new Error('Project brain approval no longer matches this directory.');
  return policy;
}
