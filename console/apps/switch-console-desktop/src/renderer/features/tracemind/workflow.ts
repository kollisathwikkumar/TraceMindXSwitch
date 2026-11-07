/** Product navigation follows the audit lifecycle; graph exploration has its own workspace. */
export const traceMindSections = [
  {
    id: 'brain',
    title: 'TraceMind brain',
    summary: 'Configure the central model, project isolation, and local context delivery.',
  },
  {
    id: 'project',
    title: 'Project intelligence',
    summary: 'Understand the project, its languages, dependencies, and audit coverage.',
  },
  {
    id: 'evidence',
    title: 'Evidence collection',
    summary: 'Capture approved snapshots. Compare changes and review the sources.',
  },
  {
    id: 'graph',
    title: 'Evidence graph',
    summary: 'Review revision-scoped relationships, provenance, and extraction coverage.',
  },
  {
    id: 'issues',
    title: 'Issues',
    summary: 'A focused register of symptoms, priorities, owners, and resolution status.',
  },
  {
    id: 'investigations',
    title: 'Investigations',
    summary: 'Build an evidence-backed case: observations, hypotheses, checks, and findings.',
  },
  {
    id: 'checks',
    title: 'Check discovery & execution',
    summary: 'Discover fixed recipes, approve a run, and inspect its recorded outcome.',
  },
  {
    id: 'local-first',
    title: 'Local architecture',
    summary: 'Understand how TraceMind runs and persists evidence inside Switch.',
  },
  {
    id: 'process',
    title: 'Investigation process',
    summary: 'Follow the path from a reported symptom to an explicitly reviewed finding.',
  },
  {
    id: 'monitoring',
    title: 'Continuous monitoring',
    summary: 'Watch approved project changes without losing the audit trail.',
  },
  {
    id: 'runtime',
    title: 'Runtime intelligence',
    summary: 'Correlate locally ingested traces, logs, and metrics with an audit.',
  },
  {
    id: 'integration',
    title: 'Switch integration',
    summary: 'Inspect communication routing, model readiness, agent handoff, and report delivery.',
  },
  {
    id: 'notes',
    title: 'Graphical notes',
    summary: 'A dedicated workspace for source connections and evidence-linked notes.',
  },
] as const;
