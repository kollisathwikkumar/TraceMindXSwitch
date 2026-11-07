// Process-local on purpose: restart never restores a watcher or a claim of freshness.
const watchedRevision = new Map<string, string>();
export function setWatchedBrainRevision(projectId: string, revision: string | null): void {
  if (revision) watchedRevision.set(projectId, revision);
  else watchedRevision.delete(projectId);
}
export function isWatchedBrainRevision(projectId: string, revision: string): boolean {
  return watchedRevision.get(projectId) === revision;
}
