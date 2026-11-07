import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import {
  correlateRuntimeIncidents,
  runtimeSignalSchema,
  type RuntimeSignal,
  type RuntimeSnapshot,
} from './model';

const locationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const auditSchema = z.string().uuid();
const persistedSchema = z
  .object({
    version: z.literal(1),
    locationId: locationSchema,
    auditId: auditSchema,
    auditRevision: z.string().max(256).nullable(),
    signals: z.array(runtimeSignalSchema).max(1_000),
    acceptedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    droppedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean(),
  })
  .strict();

function storeKey(locationId: string, auditId: string): string {
  return `tracemind:runtime:v1:${locationSchema.parse(locationId)}:${auditSchema.parse(auditId)}`;
}

export async function ingestRuntimeSignals(
  locationId: string,
  auditId: string,
  auditRevision: string | null,
  incoming: RuntimeSignal[],
  rejectedCount = 0
): Promise<RuntimeSnapshot> {
  const projectId = locationSchema.parse(locationId);
  const sourceAuditId = auditSchema.parse(auditId);
  const signals = z.array(runtimeSignalSchema).max(1_000).parse(incoming);
  const rejected = z.number().int().nonnegative().max(1_000_000).parse(rejectedCount);
  const key = storeKey(projectId, sourceAuditId);
  const raw = await db.transaction((tx) => {
    const [existing] = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).all();
    const previous = existing ? persistedSchema.parse(JSON.parse(existing.value)) : null;
    if (previous && (previous.locationId !== projectId || previous.auditId !== sourceAuditId)) {
      throw new Error('Stored telemetry project identity mismatch');
    }
    const merged = new Map((previous?.signals ?? []).map((signal) => [signal.id, signal]));
    let newCount = 0;
    for (const signal of signals) {
      if (!merged.has(signal.id)) newCount++;
      merged.set(signal.id, signal);
    }
    const chronological = [...merged.values()].sort(
      (left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id)
    );
    const overflowCount = Math.max(0, chronological.length - 1_000);
    const retained = chronological.slice(-1_000);
    const persisted = persistedSchema.parse({
      version: 1,
      locationId: projectId,
      auditId: sourceAuditId,
      auditRevision,
      signals: retained,
      acceptedCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.acceptedCount ?? 0) + newCount),
      droppedCount: Math.min(
        Number.MAX_SAFE_INTEGER,
        (previous?.droppedCount ?? 0) + rejected + Math.max(0, signals.length - newCount) + overflowCount
      ),
      truncated: Boolean(previous?.truncated) || overflowCount > 0 || rejected > 0,
    });
    if (existing) {
      tx.update(kv)
        .set({ value: JSON.stringify(persisted), updatedAt: Date.now() })
        .where(eq(kv.key, key))
        .run();
    } else {
      tx.insert(kv).values({ key, value: JSON.stringify(persisted), updatedAt: Date.now() }).run();
    }
    return persisted;
  });
  return snapshot(raw);
}

export async function getRuntimeSignals(
  locationId: string,
  auditId: string
): Promise<RuntimeSnapshot> {
  const projectId = locationSchema.parse(locationId);
  const sourceAuditId = auditSchema.parse(auditId);
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, storeKey(projectId, sourceAuditId)))
    .limit(1);
  if (!row) {
    return {
      locationId: projectId,
      auditId: sourceAuditId,
      auditRevision: null,
      signals: [],
      incidents: [],
      acceptedCount: 0,
      droppedCount: 0,
      lastReceivedAt: null,
      truncated: false,
    };
  }
  return snapshot(persistedSchema.parse(JSON.parse(row.value)));
}

function snapshot(value: z.infer<typeof persistedSchema>): RuntimeSnapshot {
  return {
    ...value,
    lastReceivedAt: value.signals.reduce<number | null>(
      (latest, signal) => Math.max(latest ?? 0, signal.observedAt),
      null
    ),
    incidents: correlateRuntimeIncidents(value.signals),
  };
}
