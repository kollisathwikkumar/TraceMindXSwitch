import { expect, it, vi } from 'vitest';
import type { PersistentGraphNode } from '../graph/model';
import { retrieveBrainContext } from './context';
const node: PersistentGraphNode = {
  schemaVersion: 1,
  id: 'n1',
  projectId: 'p1',
  revision: 'r1',
  kind: 'observation',
  label: 'Use the cache boundary',
  source: { path: 'src/cache.ts', startLine: 2, endLine: 4 },
  extractionMethod: 'user-recorded',
  provenance: 'local',
  stale: false,
  createdAt: 1,
};
function deps() {
  return {
    latest: vi.fn(async () => 'r1'),
    search: vi.fn(async () => [{ path: 'src/cache.ts', stale: false }]),
    notes: vi.fn(async () => [node]),
    changed: vi.fn(async () => false),
  };
}
it('retrieves exact indexed paths and saved notes without reading arbitrary source files', async () => {
  const d = deps();
  const result = await retrieveBrainContext('p1', 'Fix src/cache.ts', ['src/cache.ts'], d);
  expect(result.files[0]).toMatchObject({
    path: 'src/cache.ts',
    notes: [{ text: 'Use the cache boundary', startLine: 2 }],
  });
  expect(d.search).toHaveBeenCalledWith('p1', 'r1', 'src/cache.ts');
});
it('never mixes project data or invents an unindexed path', async () => {
  const d = deps();
  d.notes.mockResolvedValue([{ ...node, projectId: 'other' }]);
  await expect(retrieveBrainContext('p1', 'cache', ['src/cache.ts'], d)).rejects.toThrow(/scope/);
  d.notes.mockResolvedValue([node]);
  expect((await retrieveBrainContext('p1', 'cache', ['src/missing.ts'], d)).files).toEqual([]);
});
it('excludes secret paths and marks changed graph evidence stale', async () => {
  const d = deps();
  d.search.mockResolvedValue([
    { path: '../other/a.ts', stale: false },
    { path: '.env', stale: false },
    { path: 'src/cache.ts', stale: false },
  ]);
  d.changed.mockResolvedValue(true);
  const result = await retrieveBrainContext('p1', 'cache', ['src/cache.ts'], d);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.stale).toBe(true);
});
it('returns an explicit missing-index result and enforces request bounds', async () => {
  const d = deps();
  d.latest.mockResolvedValue(null as never);
  expect((await retrieveBrainContext('p1', 'cache', [], d)).files).toEqual([]);
  await expect(retrieveBrainContext('../p2', 'cache', [], d)).rejects.toThrow();
  await expect(retrieveBrainContext('p1', 'x'.repeat(8001), [], d)).rejects.toThrow();
});
