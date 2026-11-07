/** Typed contract shared by the TraceMind AI gateway, evidence retriever, and renderer. */
export type TraceMindEvidenceFreshness = 'fresh' | 'stale' | 'unknown';
export type TraceMindEvidenceCertainty = 'direct' | 'heuristic' | 'ambiguous' | 'recorded';
export type TraceMindEvidenceKind =
  | 'issue'
  | 'timeline'
  | 'graph'
  | 'audit'
  | 'check'
  | 'runtime'
  | 'source_excerpt';

export interface TraceMindEvidenceItem {
  id: string;
  kind: TraceMindEvidenceKind;
  label: string;
  excerpt: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  revision: string | null;
  freshness: TraceMindEvidenceFreshness;
  certainty: TraceMindEvidenceCertainty;
  provenance: string;
  extractionMethod: string;
}

export interface TraceMindEvidenceBundle {
  projectId: string;
  issueId: string;
  issueVersion: number;
  currentRevision: string | null;
  issue: {
    title: string;
    description: string;
    status: 'open' | 'investigating' | 'resolved';
    priority: 'low' | 'medium' | 'high' | 'critical';
    investigationState: string;
  };
  evidence: TraceMindEvidenceItem[];
  limitations: string[];
}

export interface TraceMindAIHypothesis {
  rank: number;
  statement: string;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  evidenceIds: string[];
}

export interface TraceMindAIRecommendation {
  rank: number;
  action: string;
  rationale: string;
  evidenceIds: string[];
}

/** Model output before provenance and persistence metadata are attached. */
export interface TraceMindAIModelResponse {
  summary: string;
  summaryEvidenceIds: string[];
  hypotheses: TraceMindAIHypothesis[];
  recommendations: TraceMindAIRecommendation[];
  limitations: string[];
}

/** Persisted suggestion snapshot. This never represents an issue resolution. */
export interface TraceMindAIInvestigation extends TraceMindAIModelResponse {
  schemaVersion: 1;
  id: string;
  provider: 'openai-compatible';
  model: string;
  generatedAt: number;
  evidenceRevision: string | null;
  evidenceReferences: Omit<TraceMindEvidenceItem, 'excerpt'>[];
  freshness: TraceMindEvidenceFreshness;
}

/** Persisted model advisory generated from an explicitly enabled runtime signal feed. */
export interface TraceMindRuntimeAIAdvisory extends TraceMindAIModelResponse {
  schemaVersion: 1;
  id: string;
  provider: 'openai-compatible';
  model: string;
  generatedAt: number;
  projectId: string;
  auditId: string;
  evidenceRevision: string | null;
  incidentIds: string[];
}

export interface TraceMindRuntimeAISettings {
  enabled: boolean;
  auditId: string;
  latestAdvisory: TraceMindRuntimeAIAdvisory | null;
  lastFailureAt: number | null;
  statusUnavailable?: boolean;
}

export interface TraceMindAIProviderStatus {
  configured: boolean;
  endpoint: string;
  model: string;
}

export interface TraceMindAIProviderTestResult {
  connected: true;
  endpoint: string;
  model: string;
}

export interface TraceMindAIProviderInput {
  endpoint: string;
  model: string;
  apiKey: string;
}
