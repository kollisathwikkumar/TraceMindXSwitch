import { expect, it, vi } from 'vitest';
import { TraceMindAIGateway } from './gateway';

it('denies project egress before touching the network when no brain grant exists', async () => {
  const values = new Map<string, string>();
  const fetcher = vi.fn<typeof fetch>();
  const gateway = new TraceMindAIGateway({
    secrets: {
      getSecret: async (key) => values.get(key) ?? null,
      setSecret: async (key, value) => {
        values.set(key, value);
      },
      deleteSecret: async (key) => {
        values.delete(key);
      },
    },
    fetcher,
  });
  await gateway.configureProvider({
    endpoint: 'https://provider.example/v1',
    model: 'model',
    apiKey: 'synthetic-test-key',
  });
  await expect(
    gateway.generateResponse({
      projectId: 'unapproved-project',
      issueId: 'issue',
      issueVersion: 1,
      currentRevision: null,
      issue: {
        title: 'task',
        description: 'private task',
        status: 'open',
        priority: 'medium',
        investigationState: 'reported',
      },
      evidence: [
        {
          id: 'e1',
          kind: 'source_excerpt',
          label: 'source',
          excerpt: 'PRIVATE SOURCE',
          path: 'src/app.ts',
          startLine: 1,
          endLine: 1,
          revision: null,
          freshness: 'unknown',
          certainty: 'direct',
          provenance: 'local',
          extractionMethod: 'source',
        },
      ],
      limitations: [],
    })
  ).rejects.toThrow(/project.*sharing|sharing.*project/i);
  expect(fetcher).not.toHaveBeenCalled();
});
