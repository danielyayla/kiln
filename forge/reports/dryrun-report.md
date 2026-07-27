# Forge migration dry-run — live store mapping report
Store: ~/.kiln/kiln.db (project "Kiln") · generated read-only

## Totals
| Kiln | count | Forge disposition |
|---|---|---|
| requirements | 35 | 1 root Intent + 27 feature Intents + 7 PHASE re-parents |
| blueprints | 35 | dissolved → Decisions; all 35 bodies archived as Sources |
| work orders | 156 | Tasks (status: cancelled 7, done 148, ready 1) |
| artifacts | 17 | Sources |
| pending suggestions | 0 | must be 0 at freeze |
| revisions | 40 | archived as Source version history |
| context receipts | 92 | Receipts (immutable, aliased) — replay set |
| completion receipts | 42 | Receipts |
| verification receipts | 1 | Receipts |
| id aliases needed | 243 | alias table rows |

## Decision volume (actual, parsed from bodies)
- Mechanical from Key-decisions bullets: **54**
- Mechanical from Conventions/constraints bullets: **29**
- Scope Decisions from requirement Non-goals bullets: **53**
- Root architecture conventions (in the above): 0 KD + 7 conventions
- Blueprints needing agent distillation (no Key-decisions section): **26** of 35

## Requirements — dispositions
| Requirement | Kind | Non-goals→Decisions | Note |
|---|---|---|---|
| Document editor & suggestions — edit documents and resolve agent-propo | FEATURE | 0 |  |
| Phase 5 — Close the authoring loop | PHASE | 0 | re-parent tasks → "Agent-assisted authoring — draft, refine" |
| Conversational document refinement | FEATURE | 0 |  |
| Dependency-aware readiness | FEATURE | 0 |  |
| Document review agent | FEATURE | 0 |  |
| Coding-agent execution skill | FEATURE | 0 |  |
| Markdown export — the whole knowledge graph as plain markdown files | FEATURE | 0 |  |
| Context inheritance up the requirement tree | FEATURE | 0 |  |
| X-ray — intent-to-execution map | FEATURE | 0 |  |
| Context Inspector — audit and diff what an agent handoff contains | FEATURE | 0 |  |
| See feature completion at a glance as a radial sunburst | FEATURE | 0 |  |
| Pulse — project health dashboard | FEATURE | 0 |  |
| Phase 11 — Pulse as home: open to a dashboard that triages | PHASE | 0 | re-parent tasks → "Pulse — project health dashboard" |
| Phase 12 — X-ray focus: one map, findable features, readable nodes | PHASE | 0 | re-parent tasks → "X-ray — intent-to-execution map" |
| Phase 13 — X-ray context clarity: explain the agent handoff | PHASE | 0 | re-parent tasks → "X-ray — intent-to-execution map" |
| Phase 14 — Root context: the product and its architecture at the top o | PHASE | 0 | re-parent tasks → "Context assembly & inheritance — one cal" |
| Kiln | ROOT | 5 |  |
| Navigator — product-aware sidebar tree of the graph | FEATURE | 0 |  |
| Phase 16 — X-ray truthfulness after the product root | PHASE | 0 | re-parent tasks → "X-ray — intent-to-execution map" |
| Phase 17 — Context Inspector redesign: answer the handoff question | PHASE | 4 | re-parent tasks → "Context Inspector — audit and diff what " |
| Agent-assisted authoring — draft, refine, and review documents with AI | FEATURE | 0 |  |
| Agent handoff over MCP — serve ready, unblocked work orders to coding  | FEATURE | 0 |  |
| Context assembly & inheritance — one call gathers a work order's full  | FEATURE | 0 |  |
| Board — work orders in status columns | FEATURE | 0 |  |
| Opinionated authoring standards — templates, health checks, and the re | FEATURE | 3 |  |
| AI settings & usage — manage the model key and see token costs | FEATURE | 5 |  |
| Authoring skills — customizable blueprint & document generation | FEATURE | 5 |  |
| Projects — multiple isolated workspaces with a switcher | FEATURE | 5 |  |
| Drift — flag documents that diverge from shipped work | FEATURE | 5 |  |
| Work types — classify work orders and tailor the agent handoff per typ | FEATURE | 4 |  |
| Auto-update — installed desktop app keeps itself current | FEATURE | 0 |  |
| Brownfield extraction — bootstrap requirements and blueprints from an  | FEATURE | 4 |  |
| Verification & criticality — completed work is judged against its acce | FEATURE | 4 |  |
| Bundled MCP server — agent handoff and survey from the installed app | FEATURE | 4 |  |
| Navigation & deep linking — addressable views so any entity, tab, or g | FEATURE | 5 |  |

## Blueprints — classification
| Blueprint | Class | KD bullets | Conv bullets | Details → |
|---|---|---|---|---|
| Phase 5 foundation — stack, conventions, constraints | ad-hoc | 0 | 0 | Phase 5 — Close the authoring loop |
| BP-10 — Project Pulse architecture | ad-hoc | 0 | 0 | Pulse — project health dashboard |
| BP-11 — Pulse as home architecture | ad-hoc | 0 | 0 | Phase 11 — Pulse as home: open to a dashboard |
| BP-12 — X-ray focus architecture | ad-hoc | 0 | 0 | Phase 12 — X-ray focus: one map, findable fea |
| BP-13 — X-ray context-at-a-glance architecture | ad-hoc | 0 | 0 | Phase 13 — X-ray context clarity: explain the |
| BP-14 — Root context architecture | ad-hoc | 0 | 0 | Phase 14 — Root context: the product and its  |
| Kiln system architecture | ad-hoc | 0 | 7 | Kiln |
| BP-15 — Product-aware sidebar architecture | ad-hoc | 0 | 0 | Navigator — product-aware sidebar tree of the |
| BP-16 — Trace and gap alignment with root context | ad-hoc | 0 | 0 | Phase 16 — X-ray truthfulness after the produ |
| BP-17 — Context Inspector redesign | ad-hoc | 0 | 2 | Phase 17 — Context Inspector redesign: answer |
| Authoring agents & suggestion pipeline | ad-hoc | 0 | 0 | Agent-assisted authoring — draft, refine, and |
| MCP bridge & readiness | ad-hoc | 0 | 0 | Agent handoff over MCP — serve ready, unblock |
| Context assembly & lineage | ad-hoc | 0 | 0 | Context assembly & inheritance — one call gat |
| Board view | ad-hoc | 0 | 0 | Board — work orders in status columns |
| Editor & suggestion resolution | ad-hoc | 0 | 0 | Document editor & suggestions — edit document |
| Auto-update blueprint — tauri-plugin-updater + GitHub Releas | ad-hoc | 0 | 0 | Auto-update — installed desktop app keeps its |
| Authoring standards & context tiers | conformant | 4 | 0 | Opinionated authoring standards — templates,  |
| AI settings, provider resolution & usage ledger | conformant | 8 | 4 | AI settings & usage — manage the model key an |
| Authoring skills & prompt injection | conformant | 5 | 3 | Authoring skills — customizable blueprint & d |
| Project registry & per-project stores | conformant | 9 | 5 | Projects — multiple isolated workspaces with  |
| Drift checks as documentHealth | conformant | 5 | 3 | Drift — flag documents that diverge from ship |
| BP-18 — Work types: first-class field + per-type handoff gui | conformant | 5 | 5 | Work types — classify work orders and tailor  |
| Survey skill & gated proposal surface | conformant | 6 | 0 | Brownfield extraction — bootstrap requirement |
| BP — Criticality field, verification receipts, and a verify  | conformant | 5 | 0 | Verification & criticality — completed work i |
| In-app agent endpoint — the sidecar hosts the MCP bridge beh | conformant | 7 | 0 | Bundled MCP server — agent handoff and survey |
| Refine agent & chat plumbing | legacy-approach | 0 | 0 | Conversational document refinement |
| depends_on semantics | legacy-approach | 0 | 0 | Dependency-aware readiness |
| Review agent | legacy-approach | 0 | 0 | Document review agent |
| Kiln execution skill | legacy-approach | 0 | 0 | Coding-agent execution skill |
| Graph-to-markdown exporter | legacy-approach | 0 | 0 | Markdown export — the whole knowledge graph a |
| Ancestor context inheritance | legacy-approach | 0 | 0 | Context inheritance up the requirement tree |
| Project X-ray view | legacy-approach | 0 | 0 | X-ray — intent-to-execution map |
| Context Assembly Inspector | legacy-approach | 0 | 0 | Context Inspector — audit and diff what an ag |
| Sunburst feature map | legacy-approach | 0 | 0 | See feature completion at a glance as a radia |
| Navigation & deep linking — hash router over (view, selected | legacy-approach | 0 | 0 | Navigation & deep linking — addressable views |

## Work orders — flags
- Re-parented from PHASE requirements: **20**
- Degraded links (no blueprint or no requirement): **7**
  - [cancelled] Implement bearer-token auth guard at the transport boundary (no implements link)
  - [cancelled] Stand up the MCP server endpoint with handshake and routing (no implements link)
  - [cancelled] Build the work-order query service for ready orders (no implements link)
  - [cancelled] Build the context assembler joining intent and code artifacts (no implements link)
  - [cancelled] Expose ready work orders and assembled context as MCP resources/tools (no implements link)
  - [cancelled] Implement the status-transition state machine validator (no implements link)
  - [cancelled] Wire the write path to validate and persist status transitions (no implements link)
- depends_on edges: 100

## Artifacts → Sources
- Competitive analysis: Software Factory (8090.ai) vs Kiln MVP — 2026-07-08 (referenced by 7 requirement(s))
- Context inheritance: finding & current-state notes (2026-07-09) (referenced by 1 requirement(s))
- Project X-ray: visualization design brief (2026-07-09) (referenced by 1 requirement(s))
- Context Assembly Inspector: design brief (2026-07-09) (referenced by 1 requirement(s))
- Sunburst feature map: design brief (2026-07-09) (referenced by 1 requirement(s))
- Design brief — Project Pulse (at-a-glance project health) (referenced by 1 requirement(s))
- Design brief — Pulse as home (dashboard, not report) (referenced by 1 requirement(s))
- Design brief — X-ray focus (remove Sunburst, make the X-ray navigable) (referenced by 1 requirement(s))
- Design brief — X-ray context clarity (referenced by 1 requirement(s))
- Phase 14 design brief — root context (referenced by 1 requirement(s))
- Feature inventory for product-overview drafting (2026-07-11) (referenced by 1 requirement(s))
- Kiln authoring methodology v1 (draft) (referenced by 2 requirement(s))
- Design brief — AI settings & usage (referenced by 1 requirement(s))
- Design brief: multi-project support (2026-07-20) (referenced by 1 requirement(s))
- Dogfood benchmark: Kiln surveyed into a fresh project — comparison vs the hand-authored tr (referenced by 1 requirement(s))
- Criticality & verification — motivating analysis (2026-07 Software Factory alignment) (referenced by 1 requirement(s))
- UX map — current navigation is a useState enum with no addressability (referenced by 1 requirement(s))