import { describe, expect, it } from 'vitest';
import type { TraceMindEvidenceBundle } from '@shared/core/tracemind/ai-investigation';
import { brainPolicySchema, projectForModel } from './policy';
const bundle: TraceMindEvidenceBundle = {
  projectId: 'p1',
  issueId: 'i1',
  issueVersion: 1,
  currentRevision: 'private-root',
  issue: {
    title: 'Fix password="synthetic-value"',
    description: 'task',
    status: 'open',
    priority: 'high',
    investigationState: 'reported',
  },
  evidence: [
    {
      id: 'e1',
      kind: 'source_excerpt',
      label: 'private label',
      excerpt: 'PRIVATE SOURCE',
      path: 'src/app.ts',
      startLine: 1,
      endLine: 2,
      revision: 'private-revision',
      freshness: 'fresh',
      certainty: 'direct',
      provenance: '/private/root',
      extractionMethod: 'source',
    },
    {
      id: 'e2',
      kind: 'graph',
      label: 'note',
      excerpt: 'private note',
      path: 'src/app.ts',
      startLine: 1,
      endLine: 2,
      revision: null,
      freshness: 'fresh',
      certainty: 'recorded',
      provenance: 'private provenance',
      extractionMethod: 'note',
    },
    {
      id: 'e3',
      kind: 'graph',
      label: 'other',
      excerpt: 'OTHER PROJECT',
      path: 'other/project.ts',
      startLine: 1,
      endLine: 1,
      revision: null,
      freshness: 'fresh',
      certainty: 'direct',
      provenance: 'local',
      extractionMethod: 'graph',
    },
  ],
  limitations: ['private limitation'],
};
const policy = {
  enabled: true,
  shareNotes: false,
  allowedPaths: ['src/app.ts'],
  endpoint: 'https://provider.example/v1',
  model: 'model',
  root: '/project',
  identity: '1:2',
  bridgeEnabled: false,
};
describe('brain egress allowlist', () => {
  it('sends only approved path metadata, never source, extra fields or local provenance', () => {
    const projected = projectForModel(bundle, policy);
    const text = JSON.stringify(projected);
    for (const secret of [
      'PRIVATE SOURCE',
      'private note',
      'OTHER PROJECT',
      '/private/root',
      'private-revision',
      'private limitation',
      'synthetic-value',
    ])
      expect(text).not.toContain(secret);
    expect(projected.evidence.map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(text).toContain('src/app.ts');
  });
  it('shares selected notes only after separate opt-in; source stays local', () => {
    const text = JSON.stringify(projectForModel(bundle, { ...policy, shareNotes: true }));
    expect(text).toContain('private note');
    expect(text).not.toContain('PRIVATE SOURCE');
  });
  it.each([
    '../other',
    '/etc/passwd',
    '.env',
    'src/../secret',
    'src\\secret',
    '.switch/agents/a.json',
    'src/\u0000.ts',
  ])('rejects excluded or escaping path %s', (path) => {
    expect(brainPolicySchema.safeParse({ ...policy, allowedPaths: [path] }).success).toBe(false);
  });
  it('fails closed when disabled and when no evidence is allowed', () => {
    expect(() => projectForModel(bundle, { ...policy, enabled: false })).toThrow(/sharing/);
    expect(() => projectForModel(bundle, { ...policy, allowedPaths: [] })).toThrow(/evidence/);
  });
});

it('drops unexpected fields and redacts incomplete private keys before truncation', () => {
  const local = structuredClone(bundle);
  Object.assign(local.issue, { privateAuthorization: 'UNEXPECTED_PRIVATE_AUTH' });
  Object.assign(local.evidence[1]!, { privateAuthorization: 'UNEXPECTED_PRIVATE_AUTH' });
  local.evidence[1]!.excerpt = 'note -----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_WITHOUT_END';
  const text = JSON.stringify(projectForModel(local, { ...policy, shareNotes: true }));
  expect(text).not.toContain('UNEXPECTED_PRIVATE_AUTH');
  expect(text).not.toContain('PRIVATE_KEY_WITHOUT_END');
});
