import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { locations } from '@main/db/schema';
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  secrets: new Map<string, string>(),
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No test database');
    return mocks.db;
  },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: () => ({}) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
}));
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {
    getSecret: async (key: string) => mocks.secrets.get(key) ?? null,
    setSecret: async (key: string, value: string) => {
      mocks.secrets.set(key, value);
    },
    deleteSecret: async (key: string) => {
      mocks.secrets.delete(key);
    },
  },
}));
vi.mock('@main/core/agents/getAgents', () => ({
  getAgents: async () => [{ switchAgentId: 'agent-one', locationId: 'project-one' }],
}));
const { tracemindController: controller } = await import('../controller');
const { handleSwitchBrain } = await import('./switch-bridge');
const { getBrainChanges, getBrainPolicy } = await import('./store');
const { getLocalBrainContext } = await import('./local-context');
let fixture: Awaited<ReturnType<typeof openFixture>>;
let dir: string;
let server: Server;
let received: string[];
let activeAudit: string | null;
beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.secrets.clear();
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tracemind-brain-e2e-')));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src/app.ts'), 'export const ORIGINAL_SOURCE_ONLY = 1;');
  await writeFile(join(dir, '.env'), 'SYNTHETIC_SECRET=must-not-leave');
  await fixture.db.insert(locations).values({ id: 'project-one', name: 'Test', dir, sshHost: '' });
  received = [];
  activeAudit = null;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString());
      const answer = {
        summary: 'The indexed app path matches the task.',
        summaryEvidenceIds: ['brain-0'],
        hypotheses: [
          {
            rank: 1,
            statement: 'The saved note may help.',
            confidence: 'low',
            rationale: 'A recorded note exists.',
            evidenceIds: ['brain-0'],
          },
        ],
        recommendations: [
          {
            rank: 1,
            action: 'Review the supplied path.',
            rationale: 'It is indexed.',
            evidenceIds: ['brain-0'],
          },
        ],
        limitations: ['Advisory only'],
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  if (activeAudit) await controller.stopAuditMonitor('project-one', activeAudit);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  fixture.close();
  mocks.db = undefined;
  await rm(dir, { recursive: true, force: true });
});
it('runs native audit → graph notes → project brain → refresh → agent report with real SQLite, watcher and loopback model HTTP', async () => {
  await controller.requestAuditApproval('project-one');
  const audit = await controller.runAudit('project-one');
  await controller.recordGraphEntry('project-one', `audit:${audit.id}`, {
    kind: 'observation',
    label: 'Use the app boundary; password="synthetic-hidden"',
    source: { path: 'src/app.ts', startLine: 1, endLine: 1 },
    reason: 'Manual note',
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  await controller.configureAIProvider({
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    model: 'fixture',
    apiKey: 'synthetic-provider-key',
  });
  await controller.configureBrainProject('project-one', {
    enabled: true,
    bridgeEnabled: true,
    shareNotes: true,
    allowedPaths: ['src/app.ts'],
  });
  expect((await getBrainPolicy('project-one'))?.root).toBe(dir);
  const context = await handleSwitchBrain({
    agentId: 'agent-one',
    cwd: dir,
    request: { type: 'context', roomId: 'room-one', messageId: 'm1', task: 'Fix src/app.ts' },
  });
  expect(context?.context).toContain('src/app.ts');
  expect(context?.context).toContain('Use the app boundary');
  expect(received).toHaveLength(1);
  for (const secret of [
    'ORIGINAL_SOURCE_ONLY',
    'SYNTHETIC_SECRET',
    'synthetic-hidden',
    'synthetic-provider-key',
    dir,
  ])
    expect(received[0]).not.toContain(secret);
  expect(
    await handleSwitchBrain({
      agentId: 'agent-other',
      cwd: dir,
      request: { type: 'context', roomId: 'room-one', messageId: 'm2', task: 'src/app.ts' },
    })
  ).toBeNull();
  const report = await handleSwitchBrain({
    agentId: 'agent-one',
    cwd: dir,
    request: {
      type: 'report',
      roomId: 'room-one',
      title: 'Observed app issue',
      description: 'Needs verification',
      paths: ['src/app.ts'],
    },
  });
  expect(report?.alert).toContain('Verification is pending');
  expect(report?.alert).not.toContain('src/app.ts');
  expect(await controller.listIssues('project-one')).toHaveLength(1);
  await expect(
    handleSwitchBrain({
      agentId: 'agent-one',
      cwd: dir,
      request: {
        type: 'report',
        roomId: 'room-one',
        title: 'Other',
        description: '',
        paths: ['other/project.ts'],
      },
    })
  ).rejects.toThrow(/not approved/);
  activeAudit = audit.id;
  await controller.startAuditMonitor('project-one', audit.id);
  await writeFile(join(dir, 'src/app.ts'), 'export const UPDATED_SOURCE_ONLY = 2;');
  await vi.waitFor(
    async () =>
      expect(
        (await getBrainChanges('project-one')).some((entry) => entry.state === 'refreshed')
      ).toBe(true),
    { timeout: 15000, interval: 250 }
  );
  const changes = await getBrainChanges('project-one');
  expect(changes.some((entry) => entry.paths.includes('src/app.ts'))).toBe(true);
  const next = await getLocalBrainContext('project-one', 'src/app.ts', ['src/app.ts']);
  expect(next.revision).not.toBe(`audit:${audit.id}`);
  expect(next.files[0]?.notes[0]?.text).toContain('Use the app boundary');
  expect(next.files[0]?.notes[0]?.stale).toBe(true);
  expect(received).toHaveLength(1); // Monitoring never calls the model.
  await controller.configureBrainProject('project-one', {
    enabled: false,
    bridgeEnabled: false,
    shareNotes: false,
    allowedPaths: [],
  });
  expect(
    await handleSwitchBrain({
      agentId: 'agent-one',
      cwd: dir,
      request: { type: 'context', roomId: 'room-one', messageId: 'm3', task: 'src/app.ts' },
    })
  ).toBeNull();
}, 25000);
