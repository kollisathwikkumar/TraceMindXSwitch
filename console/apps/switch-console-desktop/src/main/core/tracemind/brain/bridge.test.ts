import { expect, it, vi } from 'vitest';
import type { BrainPolicy } from './policy';
import { answerBrainContext } from './service';
const policy: BrainPolicy = {
  enabled: true,
  bridgeEnabled: true,
  shareNotes: true,
  allowedPaths: ['src/a.ts'],
  endpoint: 'https://provider.example/v1',
  model: 'model',
  root: '/fixture',
  identity: '1:2',
};
it('delivers only local indexed paths even when the model recommends another project', async () => {
  const local = {
    projectId: 'p1',
    revision: 'r1',
    files: [{ path: 'src/a.ts', stale: false, notes: [] }],
    limitations: [],
  };
  const generate = vi.fn(async () => ({
    model: 'model',
    response: {
      summary: 'Read /other/private.ts',
      summaryEvidenceIds: ['brain-0'],
      hypotheses: [],
      recommendations: [],
      limitations: [],
    },
  }));
  const result = await answerBrainContext('p1', 'fix a', policy, {
    retrieve: async () => local,
    generate,
  });
  expect(result.files.map((file) => file.path)).toEqual(['src/a.ts']);
  expect(result.advisory).toContain('/other/private.ts');
  expect(result.authority).toContain('not authorized');
});
it('supports local-only routing and empty-context tasks without a model request', async () => {
  const generate = vi.fn();
  const retrieve = vi.fn(async () => ({
    projectId: 'p1',
    revision: null,
    files: [],
    limitations: ['No index'],
  }));
  await answerBrainContext('p1', 'task', { ...policy, enabled: false }, { retrieve, generate });
  expect(generate).not.toHaveBeenCalled();
});
it('rejects a mismatched retrieval project before model egress', async () => {
  const generate = vi.fn();
  await expect(
    answerBrainContext('p1', 'task', policy, {
      retrieve: async () => ({ projectId: 'p2', revision: null, files: [], limitations: [] }),
      generate,
    })
  ).rejects.toThrow(/scope/);
  expect(generate).not.toHaveBeenCalled();
});
