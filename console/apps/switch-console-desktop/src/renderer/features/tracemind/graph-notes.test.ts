import { describe, expect, it } from 'vitest';
import type { GraphInspection } from '@main/core/tracemind/graph/graph-query';
import {
  connectionNotes,
  connectionPositions,
  isGraphSourcePath,
  sourceGraphInspection,
} from './graph-notes';
import { traceMindSections } from './workflow';

describe('TraceMind workflow and graphical notes', () => {
  it('keeps the audit lifecycle ordered and gives graphical notes an independent page', () => {
    expect(traceMindSections.map((item) => item.id)).toEqual([
      'brain',
      'project',
      'evidence',
      'graph',
      'issues',
      'investigations',
      'checks',
      'local-first',
      'process',
      'monitoring',
      'runtime',
      'integration',
      'notes',
    ]);
    expect(new Set(traceMindSections.map((item) => item.id)).size).toBe(13);
  });
  it('hides auxiliary paths without hiding source files with similar names', () => {
    for (const path of [
      '.unlazy/log.txt',
      'src/code.ts.modified-save',
      'dist/bundle.js',
      'pkg/node_modules/x.ts',
      'pkg\\build\\main.js',
      'pnpm-lock.yaml',
      '.DS_Store',
      'src/bundle.js.map',
      'frontend/.playwright-cli/page.yml',
      'output/verification/MODIFIED_FILE',
      'backend-rollback-test/src/index.ts',
      'BACKEND_COVERAGE_BASELINE/backend/index.ts',
      'assets/screenshot.png',
    ])
      expect(isGraphSourcePath(path), path).toBe(false);
    for (const path of [
      'src/building.ts',
      'src/node_modules-helper.ts',
      'docs/design.md',
      'package.json',
      'src/large.ts',
    ])
      expect(isGraphSourcePath(path), path).toBe(true);
  });
  it('ranks actual incoming and outgoing connections ahead of stale evidence, omitting unrelated notes', () => {
    const graph: GraphInspection = {
      nodes: ['selected', 'direct', 'heuristic', 'stale', 'unrelated'].map((id) => ({
        schemaVersion: 1,
        id,
        projectId: 'p',
        revision: 'r',
        kind: 'file',
        source: null,
        label: id,
        extractionMethod: 'fixture',
        provenance: 'fixture',
        stale: false,
        createdAt: 1,
      })),
      relationships: [
        {
          id: 'e1',
          sourceId: 'selected',
          targetId: 'heuristic',
          certainty: 'heuristic',
          stale: false,
        },
        { id: 'e2', sourceId: 'direct', targetId: 'selected', certainty: 'direct', stale: false },
        { id: 'e3', sourceId: 'selected', targetId: 'stale', certainty: 'direct', stale: true },
        { id: 'e4', sourceId: 'selected', targetId: 'selected', certainty: 'direct', stale: false },
      ].map((edge) => ({
        ...edge,
        schemaVersion: 1,
        projectId: 'p',
        revision: 'r',
        relation: 'IMPORTS',
        extractionMethod: 'fixture',
        provenance: 'fixture',
        createdAt: 1,
      })) as GraphInspection['relationships'],
      truncated: false,
      stopReason: null,
    };
    expect(connectionNotes(graph, 'selected').map((node) => node.id)).toEqual([
      'direct',
      'heuristic',
      'stale',
    ]);
    expect(connectionNotes(null, 'selected')).toEqual([]);
    expect(connectionNotes(graph, 'missing')).toEqual([]);
    const hidden = {
      ...graph.nodes[0],
      id: 'hidden',
      label: 'output/verification.ts',
      source: { path: 'output/verification.ts', startLine: 1, endLine: 1 },
    };
    const withAuxiliary = {
      ...graph,
      nodes: [...graph.nodes, hidden],
      relationships: [
        ...graph.relationships,
        { ...graph.relationships[0], id: 'hidden-edge', sourceId: 'selected', targetId: 'hidden' },
      ],
    };
    expect(
      sourceGraphInspection(withAuxiliary, false)?.nodes.some((node) => node.id === 'hidden')
    ).toBe(false);
    expect(
      sourceGraphInspection(withAuxiliary, false)?.relationships.some(
        (edge) => edge.id === 'hidden-edge'
      )
    ).toBe(false);
    expect(sourceGraphInspection(withAuxiliary, true)).toBe(withAuxiliary);
    expect(withAuxiliary.nodes).toHaveLength(6);
    const positions = connectionPositions(graph);
    expect(positions).toEqual(connectionPositions(graph));
    expect(positions.size).toBe(graph.nodes.length);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(Math.abs(point.x)).toBeLessThanOrEqual(340);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(260);
      expect(point.z).toBe(0);
    }
  });
});
