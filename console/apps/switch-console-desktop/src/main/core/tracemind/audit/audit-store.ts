import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import { AUDIT_ANALYZER_VERSION, auditNeedsRefresh } from './audit-version';
import { projectDependencyInventorySchema } from './dependency-inventory';

export { AUDIT_ANALYZER_VERSION, auditNeedsRefresh } from './audit-version';

const locationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const idSchema = z.string().uuid();
const count = z.number().int().nonnegative().max(100_000);
const inventorySchema = z
  .object({
    filesDiscovered: count,
    filesParsed: count,
    graphCoverage: z
      .object({ status: z.enum(['complete', 'partial']), omittedFiles: count })
      .strict()
      .optional(),
    skipped: count,
    skippedEntries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            reason: z.enum(['excluded', 'symlink', 'special']),
          })
          .strict()
      )
      .max(200)
      .optional(),
    skipDetailsTruncated: z.boolean().optional(),
    inventoryComplete: z.boolean(),
    errors: z
      .array(z.object({ path: z.string().max(4096), message: z.string().max(1024) }).strict())
      .max(100_000),
    languages: z
      .array(z.object({ language: z.string().max(128), files: count }).strict())
      .max(1000),
    manifests: z.array(z.string().max(4096)).max(100_000),
    dependencyInventory: projectDependencyInventorySchema.optional(),
    limitations: z.array(z.string().max(4096)).max(100),
  })
  .strict()
  .refine(
    (value) =>
      value.filesParsed <= value.filesDiscovered &&
      ((value.skippedEntries === undefined && value.skipDetailsTruncated === undefined) ||
        (value.skippedEntries !== undefined &&
          value.skipDetailsTruncated !== undefined &&
          value.skippedEntries.length <= value.skipped &&
          (value.skipDetailsTruncated || value.skippedEntries.length === value.skipped))) &&
      (!value.inventoryComplete || value.errors.length === 0)
  );
const inputSchema = z
  .object({
    locationId: locationSchema,
    root: z.string().min(1).max(4096),
    // Older records predate root identity capture and remain readable.
    identity: z
      .string()
      .regex(/^\d{1,40}:\d{1,40}$/)
      .optional(),
    revision: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    dirty: z.boolean().nullable(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    capturedAt: z.number().int().nonnegative(),
    inventory: inventorySchema,
  })
  .strict();
// analysisVersion is optional only for compatibility with persisted audits
// written before analyzer-version tracking. New records always set it below.
const auditSchema = inputSchema.extend({
  id: idSchema,
  analysisVersion: z.number().int().positive().optional(),
});

const evidenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          !/^[A-Za-z]:/.test(path) &&
          path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
      ),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AuditEvidence = z.infer<typeof evidenceSchema>;
export type EvidenceComparison =
  | { status: 'unavailable' }
  | {
      status: 'compared';
      counts: { changed: number; removed: number; added: number };
      items: { path: string; change: 'changed' | 'removed' | 'added' }[];
      truncated: boolean;
    };

export type AuditInput = z.infer<typeof inputSchema>;
export type AuditRecord = z.infer<typeof auditSchema>;

function prefix(locationId: string): string {
  return `tracemind:audit:${locationSchema.parse(locationId)}:`;
}
function auditKey(locationId: string, id: string): string {
  return `${prefix(locationId)}${idSchema.parse(id)}`;
}
function reportKey(locationId: string, id: string): string {
  return `tracemind:report:${locationSchema.parse(locationId)}:${idSchema.parse(id)}`;
}

/** Rebuilds the audit-level fingerprint from persisted path/file fingerprints. */
function evidenceSetFingerprint(entries: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  hash.update('tracemind-audit-v1\0');
  for (const [path, fingerprint] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    hash.update(`${JSON.stringify([path, fingerprint])}\n`);
  }
  return hash.digest('hex');
}

function invalidationKey(locationId: string, id: string): string {
  return `tracemind:invalidation:${locationSchema.parse(locationId)}:${idSchema.parse(id)}`;
}

const invalidationStateSchema = z.enum(['watching', 'overflow', 'error', 'stopped']);
const invalidationPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !/^[A-Za-z]:/.test(path) &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );

const auditInvalidationSchema = z
  .object({
    locationId: locationSchema,
    auditId: idSchema,
    state: invalidationStateSchema,
    stale: z.boolean(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changedCount: z.number().int().nonnegative().max(100_000_000),
    changedPaths: z.array(invalidationPathSchema).max(200),
    pathsTruncated: z.boolean(),
  })
  .strict();
const auditInvalidationInputSchema = z
  .object({
    state: invalidationStateSchema,
    eventAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changedCount: z.number().int().nonnegative().max(1_000_000),
    changedPaths: z.array(invalidationPathSchema).max(1000),
    pathsTruncated: z.boolean(),
  })
  .strict();

export type AuditInvalidation = z.infer<typeof auditInvalidationSchema>;
export type AuditInvalidationInput = z.infer<typeof auditInvalidationInputSchema>;

/** A bounded, plain-text snapshot; quoted values cannot inject report lines. */
function makeReport(audit: AuditRecord, evidence: readonly AuditEvidence[]): string {
  const quote = (value: string): string =>
    JSON.stringify(value.length > 256 ? `${value.slice(0, 256)}…` : value);
  const inv = audit.inventory;
  const freshnessWarning =
    'Some evidence may be missing; freshness is not guaranteed, and this graph must not be treated as up to date.';
  const lines = [
    'TraceMind local audit report',
    `Audit: ${audit.id}`,
    `Project root: ${quote(audit.root)}`,
    `Filesystem identity: ${audit.identity ?? 'unknown'}`,
    `Captured at (Unix ms): ${audit.capturedAt}`,
    `Analyzer version: ${audit.analysisVersion ?? 'not recorded'}${auditNeedsRefresh(audit.analysisVersion) ? ' (needs refresh)' : ' (current)'}`,
    `Revision: ${audit.revision ?? 'unknown'}`,
    `Working tree dirty: ${audit.dirty === null ? 'unknown' : audit.dirty}`,
    `Fingerprint: ${audit.fingerprint ?? 'unavailable'}`,
    `Coverage: ${inv.filesDiscovered} files, ${inv.skipped} skipped entries; ${inv.inventoryComplete ? 'complete' : 'incomplete'} inventory.`,
    `Parser coverage: ${inv.filesParsed} ${inv.filesParsed === 1 ? 'file' : 'files'} parsed; graph coverage is ${inv.graphCoverage?.status ?? 'unknown'}.`,
    'Fingerprints are TraceMind path-aware hashes, not a plain file-content SHA-256.',
    ...(inv.graphCoverage?.status === 'complete'
      ? ['Graph coverage: complete; all inventoried eligible files were parsed.']
      : [
          inv.graphCoverage?.status === 'partial'
            ? inv.graphCoverage.omittedFiles > 0
              ? `Graph coverage: partial; at least ${inv.graphCoverage.omittedFiles} eligible ${inv.graphCoverage.omittedFiles === 1 ? 'file lacks' : 'files lack'} parser-derived graph evidence. File and fingerprint metadata may still be present; additional omissions may be unknown and missing evidence is possible.`
              : 'Graph coverage: partial; no file-level parser omissions are currently quantified, but additional omissions may be unknown and missing evidence is possible.'
            : 'Graph coverage: unknown; no persisted coverage record is available.',
          freshnessWarning,
        ]),
    `Captured file evidence: ${evidence.length} entries.`,
    'File fingerprints are observations, not proof of a finding; this is not an atomic or live snapshot.',
    'Detected languages (first 50):',
    ...inv.languages.slice(0, 50).map((item) => `- ${quote(item.language)}: ${item.files}`),
    ...(inv.languages.length > 50 ? ['Additional languages are omitted from this report.'] : []),
    'Manifests (first 50):',
    ...inv.manifests.slice(0, 50).map((item) => `- ${quote(item)}`),
    ...(inv.manifests.length > 50 ? ['Additional manifests are omitted from this report.'] : []),
    `Dependency closure: ${inv.dependencyInventory?.status ?? 'unavailable'}; ${inv.dependencyInventory?.packages.length ?? 0} resolved packages and ${inv.dependencyInventory?.edges.length ?? 0} dependency edges.`,
    ...(inv.dependencyInventory?.lockfiles.length
      ? [
          'Dependency lockfiles (first 50):',
          ...inv.dependencyInventory.lockfiles.slice(0, 50).map((item) => `- ${quote(item)}`),
          ...(inv.dependencyInventory.lockfiles.length > 50
            ? ['Additional dependency lockfiles are omitted from this report.']
            : []),
          ...(inv.dependencyInventory.omittedLockfileCount
            ? [
                `Dependency inventory omitted ${inv.dependencyInventory.omittedLockfileCount} additional lockfile path(s) from its bounded path list.`,
              ]
            : []),
        ]
      : ['No supported dependency lockfile was captured.']),
    ...(inv.dependencyInventory?.unsupportedFiles?.length
      ? [
          'Unsupported dependency metadata (first 50):',
          ...inv.dependencyInventory.unsupportedFiles
            .slice(0, 50)
            .map((item) => `- ${quote(item)}`),
          ...(inv.dependencyInventory.unsupportedFiles.length > 50
            ? ['Additional unsupported dependency metadata files are omitted from this report.']
            : []),
          ...(inv.dependencyInventory.omittedUnsupportedFileCount
            ? [
                `Dependency inventory omitted ${inv.dependencyInventory.omittedUnsupportedFileCount} additional unsupported file path(s) from its bounded path list.`,
              ]
            : []),
        ]
      : []),
    'Resolved dependency packages (first 200):',
    ...(inv.dependencyInventory?.packages.slice(0, 200) ?? []).map(
      (item) =>
        `- ${item.direct ? 'direct' : 'transitive'} ${quote(item.name)}@${item.version ?? 'version unavailable'} (${item.ecosystem}; ${quote(item.sourcePath)})`
    ),
    ...(inv.dependencyInventory && inv.dependencyInventory.packages.length > 200
      ? ['Additional dependency packages are omitted from this report.']
      : []),
    ...(inv.dependencyInventory?.limitations.length
      ? [
          'Dependency coverage limitations:',
          ...inv.dependencyInventory.limitations.map((item) => `- ${quote(item)}`),
        ]
      : []),
    ...(inv.dependencyInventory?.additionalLimitationsOmitted
      ? [
          `Additional dependency limitations omitted from the bounded report: ${inv.dependencyInventory.additionalLimitationsOmitted}.`,
        ]
      : []),
    'Evidence (first 200 files):',
    ...evidence.slice(0, 200).map((item) => `- ${quote(item.path)}: ${item.fingerprint}`),
    ...(evidence.length > 200 ? ['Additional file evidence is omitted from this report.'] : []),
    'Skipped entries (first 200 recorded):',
    ...(inv.skippedEntries ?? []).map((item) => `- ${quote(item.path)}: ${item.reason}`),
    ...(inv.skipDetailsTruncated ? ['Additional skipped entries were not recorded.'] : []),
    ...(!inv.skippedEntries && inv.skipped ? ['Skipped-entry details are unavailable.'] : []),
    'Errors (first 50):',
    ...inv.errors.slice(0, 50).map((item) => `- ${quote(item.path)}: ${quote(item.message)}`),
    ...(inv.errors.length > 50 ? ['Additional errors are omitted from this report.'] : []),
    'Limitations:',
    ...inv.limitations.map((item) => `- ${quote(item)}`),
  ];
  return `${lines.join('\n')}\n`;
}
function parseRecord(raw: string, locationId: string, key: string): AuditRecord {
  const audit = auditSchema.parse(JSON.parse(raw));
  if (audit.locationId !== locationId || auditKey(locationId, audit.id) !== key) {
    throw new Error('Stored audit identity mismatch');
  }
  return audit;
}

export async function saveAudit(
  input: AuditInput,
  entries: readonly AuditEvidence[] = []
): Promise<AuditRecord> {
  const audit: AuditRecord = auditSchema.parse({
    ...inputSchema.parse(input),
    id: randomUUID(),
    analysisVersion: AUDIT_ANALYZER_VERSION,
  });
  const evidence = z.array(evidenceSchema).max(50_000).parse(entries);
  if (
    evidence.length > audit.inventory.filesDiscovered ||
    new Set(evidence.map((entry) => entry.path)).size !== evidence.length
  )
    throw new Error('Invalid audit evidence');
  const evidencePrefix = `tracemind:evidence:${audit.locationId}:${audit.id}:`;
  const report = makeReport(audit, evidence);
  db.transaction((tx) => {
    tx.insert(kv)
      .values({
        key: auditKey(audit.locationId, audit.id),
        value: JSON.stringify(audit),
        updatedAt: audit.capturedAt,
      })
      .run();
    for (let index = 0; index < evidence.length; index += 200) {
      const batch = evidence.slice(index, index + 200).map((entry, offset) => ({
        key: `${evidencePrefix}${String(index + offset).padStart(6, '0')}`,
        value: JSON.stringify(entry),
        updatedAt: audit.capturedAt,
      }));
      tx.insert(kv).values(batch).run();
    }
    tx.insert(kv)
      .values({
        key: reportKey(audit.locationId, audit.id),
        value: report,
        updatedAt: audit.capturedAt,
      })
      .run();
  });
  return audit;
}

/** Legacy audits have no saved report and return null. */
export async function getAuditReport(locationId: string, auditId: string): Promise<string | null> {
  const audit = await getAudit(locationId, auditId);
  if (!audit) throw new Error('Audit not found');
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, reportKey(locationId, auditId)))
    .limit(1);
  if (!row) return null;
  const report = z.string().max(1_000_000).parse(row.value);
  const invalidation = await getAuditInvalidation(locationId, auditId);
  const analysisNotice = auditNeedsRefresh(audit.analysisVersion)
    ? [
        'Analyzer freshness: NEEDS REFRESH.',
        `- Recorded analyzer version: ${audit.analysisVersion ?? 'not recorded'}; current version: ${AUDIT_ANALYZER_VERSION}.`,
        '- Matching file fingerprints describe the saved file snapshot only and do not refresh its derived language, manifest, dependency, or graph metadata.',
      ].join('\n')
    : '';
  if (!invalidation) return analysisNotice ? `${report.trimEnd()}\n\n${analysisNotice}\n` : report;
  const quote = (value: string): string => JSON.stringify(value.slice(0, 256));
  const paths = invalidation.changedPaths.map((path) => `- ${quote(path)}`);
  return [
    report.trimEnd(),
    ...(analysisNotice ? ['', analysisNotice] : []),
    '',
    'Live change monitor (post-snapshot, advisory):',
    `- State: ${invalidation.state}; audit snapshot is ${invalidation.stale ? 'stale' : 'not yet invalidated'}.`,
    `- Event sequence: ${invalidation.sequence}; last event time (Unix ms): ${invalidation.eventAt}.`,
    `- Changed path events: ${invalidation.changedCount}; unique paths recorded: ${invalidation.changedPaths.length}${invalidation.pathsTruncated ? ' (truncated)' : ''}.`,
    ...paths,
    'This marker does not alter snapshot fingerprints or make the filesystem scan atomic.',
    '',
  ].join('\n');
}

/** Reads the separately persisted post-snapshot watcher marker for one project audit. */
export async function getAuditInvalidation(
  locationId: string,
  auditId: string
): Promise<AuditInvalidation | null> {
  if (!(await getAudit(locationId, auditId))) throw new Error('Audit not found');
  const key = invalidationKey(locationId, auditId);
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
  if (!row) return null;
  const marker = auditInvalidationSchema.parse(JSON.parse(row.value));
  if (marker.locationId !== locationSchema.parse(locationId) || marker.auditId !== auditId) {
    throw new Error('Stored audit invalidation identity mismatch');
  }
  return marker;
}

/**
 * Appends a bounded advisory change marker without rewriting the original audit snapshot,
 * fingerprint, or report. Staleness is monotonic for an audit id; a new audit is required
 * to establish a new snapshot after a change, overflow, watcher error, or stop.
 */
export async function recordAuditInvalidation(
  locationId: string,
  auditId: string,
  input: AuditInvalidationInput
): Promise<AuditInvalidation> {
  const parsedLocation = locationSchema.parse(locationId);
  const parsedAudit = idSchema.parse(auditId);
  const event = auditInvalidationInputSchema.parse(input);
  if (!(await getAudit(parsedLocation, parsedAudit))) throw new Error('Audit not found');
  const key = invalidationKey(parsedLocation, parsedAudit);
  return db.transaction((tx) => {
    const [row] = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).all();
    const previous = row ? auditInvalidationSchema.parse(JSON.parse(row.value)) : null;
    if (previous && (previous.locationId !== parsedLocation || previous.auditId !== parsedAudit)) {
      throw new Error('Stored audit invalidation identity mismatch');
    }
    const sequence = (previous?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Audit invalidation sequence exhausted');
    const changedPaths = [
      ...new Set([...(previous?.changedPaths ?? []), ...event.changedPaths]),
    ].sort();
    const marker = auditInvalidationSchema.parse({
      locationId: parsedLocation,
      auditId: parsedAudit,
      state: event.state,
      stale:
        Boolean(previous?.stale) ||
        event.state !== 'watching' ||
        event.changedCount > 0 ||
        event.changedPaths.length > 0 ||
        event.pathsTruncated,
      sequence,
      eventAt: Math.max(previous?.eventAt ?? 0, event.eventAt),
      changedCount: Math.min(100_000_000, (previous?.changedCount ?? 0) + event.changedCount),
      changedPaths: changedPaths.slice(0, 200),
      pathsTruncated:
        Boolean(previous?.pathsTruncated) || event.pathsTruncated || changedPaths.length > 200,
    });
    if (previous) {
      tx.update(kv)
        .set({ value: JSON.stringify(marker), updatedAt: marker.eventAt })
        .where(eq(kv.key, key))
        .run();
    } else {
      tx.insert(kv)
        .values({ key, value: JSON.stringify(marker), updatedAt: marker.eventAt })
        .run();
    }
    return marker;
  });
}

export async function listAuditEvidence(
  locationId: string,
  auditId: string,
  offset: number,
  limit: number
): Promise<{ items: AuditEvidence[]; nextOffset: number | null }> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 50_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error('Invalid evidence pagination');
  if (!(await getAudit(locationId, auditId))) throw new Error('Audit not found');
  const start = `tracemind:evidence:${locationSchema.parse(locationId)}:${idSchema.parse(auditId)}:`;
  const rows = await db
    .select({ value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
    .orderBy(asc(kv.key))
    .limit(limit + 1)
    .offset(offset);
  const items = rows.slice(0, limit).map((row) => evidenceSchema.parse(JSON.parse(row.value)));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}

/** Compares persisted snapshots, not the current filesystem. The result is bounded. */
export async function compareAuditEvidence(
  locationId: string,
  previousId: string,
  currentId: string
): Promise<EvidenceComparison> {
  const [previous, current] = await Promise.all([
    getAudit(locationId, previousId),
    getAudit(locationId, currentId),
  ]);
  if (!previous || !current) throw new Error('Audit not found');
  if (
    previous.root !== current.root ||
    !previous.identity ||
    !current.identity ||
    !previous.fingerprint ||
    !current.fingerprint ||
    // A replaced filesystem object at the same root path is comparable only
    // when its complete path-aware snapshot fingerprint is identical. This
    // preserves the identity boundary for changed trees while allowing an
    // exact-content snapshot comparison after volume remounts or root swaps.
    (previous.identity !== current.identity && previous.fingerprint !== current.fingerprint) ||
    !previous.inventory.inventoryComplete ||
    !current.inventory.inventoryComplete
  )
    return { status: 'unavailable' };

  const load = async (audit: AuditRecord): Promise<Map<string, string> | null> => {
    const start = `tracemind:evidence:${locationSchema.parse(locationId)}:${idSchema.parse(audit.id)}:`;
    const rows = await db
      .select({ value: kv.value })
      .from(kv)
      .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
      .limit(50_001);
    if (rows.length !== audit.inventory.filesDiscovered || rows.length > 50_000) return null;
    const entries = new Map<string, string>();
    for (const row of rows) {
      const entry = evidenceSchema.parse(JSON.parse(row.value));
      if (entries.has(entry.path)) return null;
      entries.set(entry.path, entry.fingerprint);
    }
    return entries;
  };
  const [before, after] = await Promise.all([load(previous), load(current)]);
  if (!before || !after) return { status: 'unavailable' };
  // A row can be syntactically valid and keep the expected count while still
  // being missing, substituted, or corrupted. Do not compare it as if it were
  // the evidence set represented by the audit-level snapshot fingerprint.
  if (
    evidenceSetFingerprint(before) !== previous.fingerprint ||
    evidenceSetFingerprint(after) !== current.fingerprint
  )
    return { status: 'unavailable' };
  const counts = { changed: 0, removed: 0, added: 0 };
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const items: { path: string; change: 'changed' | 'removed' | 'added' }[] = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    const change =
      a === undefined ? 'added' : b === undefined ? 'removed' : a !== b ? 'changed' : null;
    if (change) {
      counts[change]++;
      if (items.length < 200) items.push({ path, change });
    }
  }
  return {
    status: 'compared',
    counts,
    items,
    truncated: counts.changed + counts.removed + counts.added > items.length,
  };
}
export async function getAudit(locationId: string, id: string): Promise<AuditRecord | null> {
  const key = auditKey(locationId, id);
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).limit(1);
  return row ? parseRecord(row.value, locationId, key) : null;
}

/** Persist graph coverage with the saved report after indexing completes. */
export async function recordGraphCoverage(
  locationId: string,
  id: string,
  coverage: { status: 'complete' | 'partial'; omittedFiles: number; filesParsed: number }
): Promise<AuditRecord> {
  const audit = await getAudit(locationId, id);
  if (!audit) throw new Error('Audit not found');
  if (
    !Number.isSafeInteger(coverage.filesParsed) ||
    coverage.filesParsed < 0 ||
    coverage.filesParsed > audit.inventory.filesDiscovered ||
    !Number.isSafeInteger(coverage.omittedFiles) ||
    coverage.omittedFiles < 0 ||
    coverage.omittedFiles > audit.inventory.filesDiscovered
  ) {
    throw new Error('Invalid graph coverage');
  }
  if (coverage.filesParsed + coverage.omittedFiles !== audit.inventory.filesDiscovered) {
    throw new Error('Graph coverage counts must account for every inventoried file');
  }
  // Keep the persistence boundary conservative: callers cannot promote an
  // incomplete scan, an un-fingerprinted snapshot, or known parser omissions
  // to complete coverage. This also protects against future callers that do
  // not use runLocalAudit's coverage calculation.
  if (
    coverage.status === 'complete' &&
    (!audit.inventory.inventoryComplete || audit.inventory.errors.length > 0 || !audit.fingerprint)
  ) {
    throw new Error('Complete graph coverage requires a complete fingerprinted inventory');
  }
  if (
    coverage.status === 'complete' &&
    (coverage.omittedFiles !== 0 || coverage.filesParsed !== audit.inventory.filesDiscovered)
  ) {
    throw new Error('Complete graph coverage requires zero omissions and every file parsed');
  }
  const prefix = `tracemind:evidence:${locationSchema.parse(locationId)}:${idSchema.parse(id)}:`;
  const rows = await db
    .select({ value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, prefix), lt(kv.key, `${prefix}\uffff`)))
    .orderBy(asc(kv.key))
    .limit(50_001);
  if (rows.length > 50_000) throw new Error('Audit evidence limit exceeded');
  const evidence = rows.map((row) => evidenceSchema.parse(JSON.parse(row.value)));
  const updated = auditSchema.parse({
    ...audit,
    inventory: {
      ...audit.inventory,
      filesParsed: coverage.filesParsed,
      graphCoverage: {
        status: coverage.status,
        omittedFiles: coverage.omittedFiles,
      },
    },
  });
  const report = makeReport(updated, evidence);
  db.transaction((tx) => {
    tx.update(kv)
      .set({ value: JSON.stringify(updated), updatedAt: updated.capturedAt })
      .where(eq(kv.key, auditKey(locationId, id)))
      .run();
    tx.update(kv)
      .set({ value: report, updatedAt: updated.capturedAt })
      .where(eq(kv.key, reportKey(locationId, id)))
      .run();
  });
  return updated;
}

/** Records indexing/coverage failure metadata without discarding the saved audit. */
export async function recordGraphIndexFailure(
  locationId: string,
  id: string,
  coverage?: { omittedFiles: number; filesParsed: number }
): Promise<AuditRecord> {
  const audit = await getAudit(locationId, id);
  if (!audit) throw new Error('Audit not found');
  const incompleteCoverage = {
    omittedFiles: coverage?.omittedFiles ?? audit.inventory.filesDiscovered,
    filesParsed: coverage?.filesParsed ?? 0,
  };
  if (
    !Number.isSafeInteger(incompleteCoverage.omittedFiles) ||
    incompleteCoverage.omittedFiles < 0 ||
    incompleteCoverage.omittedFiles > audit.inventory.filesDiscovered ||
    !Number.isSafeInteger(incompleteCoverage.filesParsed) ||
    incompleteCoverage.filesParsed < 0 ||
    incompleteCoverage.filesParsed > audit.inventory.filesDiscovered
  ) {
    throw new Error('Invalid graph coverage');
  }
  const evidencePrefix = `tracemind:evidence:${locationSchema.parse(locationId)}:${idSchema.parse(id)}:`;
  const rows = await db
    .select({ value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, evidencePrefix), lt(kv.key, `${evidencePrefix}\uffff`)))
    .orderBy(asc(kv.key))
    .limit(50_001);
  if (rows.length > 50_000) throw new Error('Audit evidence limit exceeded');
  const evidence = rows.map((row) => evidenceSchema.parse(JSON.parse(row.value)));
  const message = 'Evidence graph indexing failed; audit and file evidence remain available.';
  const freshnessMessage = 'Historical graph freshness may be incomplete after indexing failure.';
  const limitations = [
    ...audit.inventory.limitations.filter((item) => item !== message && item !== freshnessMessage),
    message,
    freshnessMessage,
  ];
  const updated: AuditRecord = {
    ...audit,
    inventory: {
      ...audit.inventory,
      filesParsed: incompleteCoverage.filesParsed,
      graphCoverage: { status: 'partial', omittedFiles: incompleteCoverage.omittedFiles },
      limitations: limitations.slice(-100),
    },
  };
  const report = makeReport(updated, evidence);
  db.transaction((tx) => {
    tx.update(kv)
      .set({ value: JSON.stringify(updated), updatedAt: updated.capturedAt })
      .where(eq(kv.key, auditKey(locationId, id)))
      .run();
    tx.update(kv)
      .set({ value: report, updatedAt: updated.capturedAt })
      .where(eq(kv.key, reportKey(locationId, id)))
      .run();
  });
  return updated;
}

export async function listAudits(locationId: string): Promise<AuditRecord[]> {
  const start = prefix(locationId);
  const rows = await db
    .select({ key: kv.key, value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
    .orderBy(desc(sql`rowid`));
  return rows.map((row) => parseRecord(row.value, locationId, row.key));
}
