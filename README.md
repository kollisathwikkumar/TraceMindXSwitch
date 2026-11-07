# TraceMind × Switch

**TraceMind brings project intelligence and evidence-backed investigations into Switch.** It keeps project evidence local by default, connects file-level audit snapshots to a bounded static graph, and gives teams a structured place to track issues, hypotheses, evidence, and approved checks.

> **Scope:** This repository contains a focused source snapshot of the TraceMind feature integrated with Switch. It does **not** include the Switch desktop/Electron application shell, packaging configuration, or the separate standalone TraceMind project. The feature source still expects Switch host services (project/location registry, IPC, SQLite persistence, lifecycle, and encrypted-secret adapters), so this repository is not a self-running application.
>
> **Status:** Capability labels below describe the current working-tree implementation and focused tests. They are not a release certification or a claim that every workflow has been validated in an installed Switch build.

## What TraceMind does in Switch

TraceMind helps a team inspect a local project and keep an evidence trail around an issue. Its evidence is deliberately bounded and labelled: a file inventory is not a complete semantic analysis, a graph edge is not proof of runtime behavior, an AI suggestion is not a finding, and a successful test does not by itself resolve an issue.

| Capability | Current status | What is implemented |
| --- | --- | --- |
| Project intelligence | **Partial** | Selects a Switch project/location, records Git revision and dirty-state evidence, inventories file names/manifests, fingerprints eligible files, and parses bounded dependency evidence. |
| Evidence collection | **Partial** | Saves local audit metadata, coverage, omissions/errors and a report. An optional, separately approved monitor can mark a snapshot stale and schedule a new local audit/graph refresh. |
| Evidence graph | **Partial** | Builds revision-scoped static nodes/relationships with source and extraction certainty; provides bounded neighborhoods and paginated relationship reads. |
| Issues and investigations | **Partial** | Stores project-scoped issues, legal lifecycle edits, priority/owner, a 14-phase investigation workflow, append-only timeline events, linked evidence/check outcomes, and a report. |
| Check discovery and execution | **Partial; platform-dependent** | Proposes a finite set of fixed test recipes from audited manifests. Execution requires a separate one-use approval and host capability checks. See the platform table below. |
| Local-first core and AI/agent integration | **Bounded local core implemented; model/bridge integration partial** | Core audit, graph, issue, and run records are local. Optional provider and Switch-session integrations use separate project-scoped sharing controls; live provider/connector delivery is not certified. |

### What works today

- **Project audit:** records a bounded inventory, eligible-file fingerprints, Git state, analyzer version, coverage, skipped paths, errors, and limitations. An audit is not an atomic filesystem snapshot.
- **Dependency evidence:** parses supported evidence from npm lockfile v2/v3, pnpm lockfile v6–v9, Cargo.lock v1–v4, and Poetry lock metadata v1.1/2.0/2.1. Unsupported or incomplete inputs remain partial; a manifest-only declaration does not establish a transitive dependency graph.
- **Static graph:** TypeScript/JavaScript use the TypeScript parser. Bounded lexical adapters cover C, C++, C#, Go, Java, Python, and Rust. Relationships retain revision/source/extraction/certainty metadata; heuristic or ambiguous edges remain explicitly uncertain.
- **Investigation trail:** issues support `open`, `investigating`, and `resolved`; the separate investigation state machine records phases, rationale, observations, hypotheses, findings, stale evidence, and terminal check summaries. A test result never changes issue state automatically.
- **Optional freshness monitor:** requires its own approval, watches one project per app process, and adds an advisory invalidation marker. It is not automatically started or resumed after restart; new audits are still needed to refresh the underlying snapshot.
- **Optional AI and Switch context:** a configured OpenAI-compatible model can produce advisory, issue-linked investigation content from bounded, approved context. Provider calls are not automatic. A saved key/provider is not proof of successful generation or live platform delivery.

### Check execution by host

| Host | Status | Current behavior |
| --- | --- | --- |
| macOS | **Available, unverified only** | Separately approved commands run sequentially inside Seatbelt. Effective process/memory controls and descendant cleanup are not confirmed, so results remain unverified. |
| Linux | **Partial / capability-dependent** | Requires the supported Bubblewrap path and a writable delegated cgroup v2 subtree with `memory` and `pids` already available. Missing capability fails closed before the target starts. |
| Windows | **Unavailable in the production controller path** | Windows handoff/MXC helpers have tests, but the production controller/runtime path is not wired to a Windows runner. |

Discovery proposes fixed recipes only; it does not run project manifests. Approval authorizes a proposed check but does not itself prove containment. A passed check only reports what that recorded command did—it does not prove symptom coverage or resolution.

## How it works

```text
Select a Switch project/location
        │
        ├─ grant consent separately for the requested operation
        ▼
Bounded local audit ──► fingerprints + inventory + coverage/omissions
        │                                      │
        ├─ optional, separately approved monitor│
        │                                      ▼
        └──────────────────────────────► versioned static evidence graph
                                               │
                                               ▼
                                    issue + investigation timeline
                                       │                   │
                     optional approved model context     │ fixed check proposal
                                       │                   │
                                       ▼                   ▼
                                advisory output      one-use approval
                                                           │
                                                           ▼
                                               recorded check outcome/report
```

1. Select a local Switch location. Selection is distinct from consent; audit, monitoring, and checks use separately scoped approvals.
2. Capture an audit. TraceMind stores bounded metadata and fingerprints locally and makes unsupported, unreadable, oversized, or omitted evidence visible.
3. Inspect the static graph and attach observations to an issue. Every graph revision and relationship carries provenance and certainty; it is not a runtime call graph.
4. Advance the issue through legal investigation phases and preserve a bounded, append-only timeline. Review stale/unknown evidence before relying on it.
5. If wanted, configure a compatible model and explicitly request an investigation. Only the selected bounded context is sent; output remains advisory and is recorded with its evidence references and limits.
6. Review a fixed test proposal from the audited snapshot and grant a one-use approval before execution. The host-specific controls above determine whether a result can be reported as verified.

## Architecture in this repository

```text
console/apps/switch-console-desktop/src/
├── main/core/tracemind/         # audit, graph, issue, brain, runtime, verification services
├── renderer/features/tracemind/ # Switch UI, issue workflow, graph and audit surfaces
└── shared/core/tracemind/       # shared contracts and types

docs/tracemind/
├── current-state-architecture.md
├── brain-setup.md
└── ai-investigation.md
```

The feature is part of Switch's desktop-host integration, but the host shell, Electron build/configuration, unrelated Switch packages, and generated build output are intentionally not included here. Import paths and runtime adapters expect the matching Switch workspace. Use this repository as the feature source snapshot to integrate/review—not as a standalone install.

## Development and tests

Run the feature tests from a matching Switch Console checkout after installing its workspace dependencies. From `console/apps/switch-console-desktop/`:

```sh
../../node_modules/.bin/vitest run \
  --project node --project main-db --project browser \
  src/main/core/tracemind \
  src/renderer/features/tracemind \
  src/shared/core/tracemind
```

The source snapshot includes the feature tests, but not the host workspace's Vitest configuration or dependency manifests. The current-state matrix and setup notes in [`docs/tracemind/`](docs/tracemind/) are the canonical behavior/limitation reference.

## Repository layout and notices

- `console/apps/switch-console-desktop/src/main/core/tracemind/` — feature services, persistence adapters, parsers, graph, investigation, model boundary, and check orchestration.
- `console/apps/switch-console-desktop/src/renderer/features/tracemind/` — feature UI and renderer tests.
- `console/apps/switch-console-desktop/src/shared/core/tracemind/` — shared feature contracts.
- `docs/tracemind/` — current-state architecture and focused setup guides.
- `LICENSE` and `NOTICE` — applicable license terms and attribution notices.

The core stays local by default, but optional model/runtime integrations can make network requests. Do not treat this feature, its reports, graph relationships, or model output as a guarantee of complete coverage, confidentiality, causation, verification, or issue resolution. Review the full license and notices before redistributing.
