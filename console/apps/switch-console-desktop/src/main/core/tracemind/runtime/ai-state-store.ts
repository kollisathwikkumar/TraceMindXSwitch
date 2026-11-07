import { and, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import type { TraceMindRuntimeAIAdvisory } from '@shared/core/tracemind/ai-investigation';

const locationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const auditSchema = z.string().uuid();
const consentSchema = z.boolean();
const failureTimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const consentPrefix = 'tracemind:runtime-ai-consent:v1:';
const citationIds = z.array(z.string().min(1).max(240)).min(1).max(30);
const advisorySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    provider: z.literal('openai-compatible'),
    model: z.string().min(1).max(100),
    generatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    projectId: locationSchema,
    auditId: auditSchema,
    evidenceRevision: z.string().max(256).nullable(),
    incidentIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(10),
    summary: z.string().trim().min(1).max(8_000),
    summaryEvidenceIds: citationIds,
    hypotheses: z
      .array(
        z
          .object({
            rank: z.number().int().positive(),
            statement: z.string().trim().min(1).max(2_000),
            confidence: z.enum(['low', 'medium', 'high']),
            rationale: z.string().trim().min(1).max(4_000),
            evidenceIds: citationIds,
          })
          .strict()
      )
      .min(1)
      .max(10),
    recommendations: z
      .array(
        z
          .object({
            rank: z.number().int().positive(),
            action: z.string().trim().min(1).max(2_000),
            rationale: z.string().trim().min(1).max(4_000),
            evidenceIds: citationIds,
          })
          .strict()
      )
      .min(1)
      .max(10),
    limitations: z.array(z.string().trim().min(1).max(1_000)).max(30),
  })
  .strict()
  .superRefine((advisory, context) => {
    const valid = new Set(advisory.incidentIds);
    const citedIds = [
      ...advisory.summaryEvidenceIds,
      ...advisory.hypotheses.flatMap((item) => item.evidenceIds),
      ...advisory.recommendations.flatMap((item) => item.evidenceIds),
    ];
    if (citedIds.some((id) => !valid.has(id))) {
      context.addIssue({ code: 'custom', message: 'Runtime advisory cites an unlinked incident.' });
    }
  });

function consentKey(locationId: string, auditId: string): string {
  return `${consentPrefix}${locationSchema.parse(locationId)}:${auditSchema.parse(auditId)}`;
}

function advisoryKey(locationId: string, auditId: string): string {
  return `tracemind:runtime-ai-advisory:v1:${locationSchema.parse(locationId)}:${auditSchema.parse(auditId)}`;
}

function failureKey(locationId: string, auditId: string): string {
  return `tracemind:runtime-ai-failure:v1:${locationSchema.parse(locationId)}:${auditSchema.parse(auditId)}`;
}

export async function getRuntimeAIEnabled(locationId: string, auditId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, consentKey(locationId, auditId)))
    .limit(1);
  return row ? consentSchema.parse(JSON.parse(row.value)) : false;
}

export async function setRuntimeAIEnabled(
  locationId: string,
  auditId: string,
  enabled: boolean
): Promise<boolean> {
  const key = consentKey(locationId, auditId);
  const value = JSON.stringify(consentSchema.parse(enabled));
  await db
    .insert(kv)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } })
    .execute();
  return enabled;
}

/** Revokes every persisted per-audit runtime egress consent for this local app profile. */
export async function clearAllRuntimeAIEnabled(): Promise<void> {
  await db
    .update(kv)
    .set({ value: 'false', updatedAt: Date.now() })
    .where(and(gte(kv.key, consentPrefix), lt(kv.key, `${consentPrefix}\uffff`)))
    .execute();
}

export async function getRuntimeAILastFailureAt(
  locationId: string,
  auditId: string
): Promise<number | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, failureKey(locationId, auditId)))
    .limit(1);
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.value);
  return failureTimeSchema.parse(parsed);
}

/** Stores only a timestamp; provider error text, endpoint, and request content are intentionally omitted. */
export async function recordRuntimeAIAnalysisFailure(
  locationId: string,
  auditId: string,
  failedAt = Date.now()
): Promise<void> {
  const value = JSON.stringify(failureTimeSchema.parse(failedAt));
  const key = failureKey(locationId, auditId);
  await db
    .insert(kv)
    .values({ key, value, updatedAt: failedAt })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: failedAt } })
    .execute();
}

export async function getLatestRuntimeAIAdvisory(
  locationId: string,
  auditId: string
): Promise<TraceMindRuntimeAIAdvisory | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, advisoryKey(locationId, auditId)))
    .limit(1);
  if (!row) return null;
  const advisory = advisorySchema.parse(JSON.parse(row.value));
  if (advisory.projectId !== locationId || advisory.auditId !== auditId) {
    throw new Error('Stored runtime AI advisory identity mismatch');
  }
  return advisory;
}

export async function recordRuntimeAIAdvisory(
  locationId: string,
  auditId: string,
  input: TraceMindRuntimeAIAdvisory
): Promise<void> {
  const advisory = advisorySchema.parse(input);
  if (advisory.projectId !== locationId || advisory.auditId !== auditId) {
    throw new Error('Runtime AI advisory project identity mismatch');
  }
  const key = advisoryKey(locationId, auditId);
  const value = JSON.stringify(advisory);
  if (Buffer.byteLength(value, 'utf8') > 128 * 1024) {
    throw new Error('Runtime AI advisory exceeds the local storage limit');
  }
  const savedAt = Date.now();
  await db.transaction((tx) => {
    tx.insert(kv)
      .values({ key, value, updatedAt: savedAt })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: savedAt } })
      .run();
    tx.delete(kv)
      .where(eq(kv.key, failureKey(locationId, auditId)))
      .run();
  });
}
