# Forge migration dry-run — live store mapping report
Store: /private/tmp/claude-501/-Users-danielkapper-Projects-kiln/4de6554c-6a79-4516-80ba-7eb3511eba66/scratchpad/macro-snapshot2.db · generated read-only

## Totals
| Kiln | count | Forge disposition |
|---|---|---|
| requirements | 2 | 1 root Intent + 1 feature Intents + 0 PHASE re-parents |
| blueprints | 2 | dissolved → Decisions; all 2 bodies archived as Sources |
| work orders | 0 | Tasks (status: ) |
| artifacts | 1 | Sources |
| pending suggestions | 0 | must be 0 at freeze |
| revisions | 4 | archived as Source version history |
| context receipts | 0 | Receipts (immutable, aliased) — replay set |
| completion receipts | 0 | Receipts |
| verification receipts | 0 | Receipts |
| id aliases needed | 5 | alias table rows |

## Decision volume (actual, parsed from bodies)
- Mechanical from Key-decisions bullets: **3**
- Mechanical from Conventions/constraints bullets: **0**
- Scope Decisions from requirement Non-goals bullets: **6**
- Root architecture conventions (in the above): 0 KD + 0 conventions
- Blueprints needing agent distillation (no Key-decisions section): **1** of 2

## Requirements — dispositions
| Requirement | Kind | Non-goals→Decisions | Note |
|---|---|---|---|
| Macro Tracker Survey | ROOT | 3 |  |
| Keto logging over MCP — log meals, ketone and glucose readings from Cl | FEATURE | 3 |  |

## Blueprints — classification
| Blueprint | Class | KD bullets | Conv bullets | Details → |
|---|---|---|---|---|
| Macro Tracker Survey system architecture | ad-hoc | 0 | 0 | Macro Tracker Survey |
| BP — MCP keto logging tools on the Worker | conformant | 3 | 0 | Keto logging over MCP — log meals, ketone and |

## Work orders — flags
- Re-parented from PHASE requirements: **0**
- Degraded links (no blueprint or no requirement): **0**
- depends_on edges: 0

## Artifacts → Sources
- Survey evidence: MCP keto logging (mcp/register-tools.ts, mcp/tools/log-food.ts, migration (referenced by 1 requirement(s))