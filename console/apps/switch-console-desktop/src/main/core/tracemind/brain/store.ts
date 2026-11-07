import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import { brainPolicySchema, type BrainPolicy } from './policy';

const project = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const changeSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  paths: z.array(z.string().max(4096)).max(200),
  truncated: z.boolean(),
  state: z.enum(['pending', 'refreshed', 'error', 'stopped']),
  auditId: z.string().uuid().nullable(),
});
export type BrainChange = z.infer<typeof changeSchema>;
const journalSchema = z.array(changeSchema).max(200);
function key(id: string, kind: string): string {
  return `tracemind:brain:v1:${project.parse(id)}:${kind}`;
}
export async function getBrainPolicy(id: string): Promise<BrainPolicy | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(id, 'policy')))
    .limit(1);
  return row ? brainPolicySchema.parse(JSON.parse(row.value)) : null;
}
export async function saveBrainPolicy(id: string, policy: BrainPolicy): Promise<BrainPolicy> {
  const parsed = brainPolicySchema.parse(policy);
  const name = key(id, 'policy');
  const value = JSON.stringify(parsed);
  await db
    .insert(kv)
    .values({ key: name, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } });
  return parsed;
}
export async function getBrainChanges(id: string): Promise<BrainChange[]> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(id, 'changes')))
    .limit(1);
  return row ? journalSchema.parse(JSON.parse(row.value)) : [];
}
/** Serialized by SQLite; bounded history, never stores source contents or raw watcher errors. */
export async function recordBrainChange(id: string, change: BrainChange): Promise<void> {
  const name = key(id, 'changes');
  const parsed = changeSchema.parse(change);
  db.transaction((tx) => {
    const row = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, name)).get();
    const previous = row ? journalSchema.parse(JSON.parse(row.value)) : [];
    const value = JSON.stringify([...previous, parsed].slice(-200));
    tx.insert(kv)
      .values({ key: name, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } })
      .run();
  });
}
