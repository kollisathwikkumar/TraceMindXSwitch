import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { saveBrainPolicy, getBrainPolicy, recordBrainChange, getBrainChanges } =
  await import('./store');
let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
});
afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});
it('persists project grants across a second SQLite connection without granting another project', async () => {
  expect(await getBrainPolicy('one')).toBeNull();
  const policy = {
    enabled: true,
    bridgeEnabled: true,
    shareNotes: false,
    allowedPaths: ['src/app.ts'],
    endpoint: 'https://provider.example/v1',
    model: 'fixture',
    root: '/fixture',
    identity: '1:2',
  };
  await saveBrainPolicy('one', policy);
  const reopened = new Database(fixture.sqlite.name);
  try {
    mocks.db = drizzle(reopened, { schema });
    expect(await getBrainPolicy('one')).toEqual(policy);
    expect(await getBrainPolicy('two')).toBeNull();
  } finally {
    reopened.close();
    mocks.db = fixture.db;
  }
  await expect(saveBrainPolicy('one', { ...policy, allowedPaths: ['../other'] })).rejects.toThrow();
  await expect(getBrainPolicy('../one')).rejects.toThrow();
});
it('keeps bounded, independently scoped change history and rejects unbounded records', async () => {
  for (let sequence = 1; sequence <= 202; sequence++)
    await recordBrainChange('one', {
      sequence,
      at: sequence,
      paths: ['src/app.ts'],
      truncated: false,
      state: 'pending',
      auditId: null,
    });
  const records = await getBrainChanges('one');
  expect(records).toHaveLength(200);
  expect(records[0]?.sequence).toBe(3);
  expect(await getBrainChanges('two')).toEqual([]);
  await expect(
    recordBrainChange('one', {
      ...records[0]!,
      paths: Array.from({ length: 201 }, () => 'src/app.ts'),
    })
  ).rejects.toThrow();
});
