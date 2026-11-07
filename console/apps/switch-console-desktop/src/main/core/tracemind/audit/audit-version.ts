/** Increment when audit-derived metadata semantics change in a way that requires re-analysis. */
export const AUDIT_ANALYZER_VERSION = 5;

/** Treat missing, older, and newer analyzer versions as needing a fresh audit. */
export function auditNeedsRefresh(analysisVersion: number | undefined): boolean {
  return analysisVersion !== AUDIT_ANALYZER_VERSION;
}
