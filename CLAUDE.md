# Kiln — agent working notes

## What this is
An AI-native SDLC tool that keeps a knowledge graph linking
intent -> requirement -> blueprint -> work order, and hands coding agents
fully-contextualized work orders over MCP.

Read `docs/PRD.md` first, then `docs/blueprint.md` — BP-0 is the foundation
(stack, repo layout, and the conventions below).

## How to work
- Implement work orders from `docs/work-orders.md` **in order, one at a time**.
- Each work order names its requirement (`docs/requirements.md`) and its blueprint
  section (`docs/blueprint.md`). Read both before starting.
- **Stop after each work order for review.** Do not start the next one unprompted.
- Everything goes through the `Store` interface. No SQL or database-driver imports
  outside `packages/core/src/store` and `packages/core/src/db`.
- Validate at boundaries with Zod. Prefer small, tested increments.
- **Features, not phases.** The tree under the "Kiln" product root
  holds enduring capability FEATURES (X-ray, Pulse, Board, Agent-assisted
  authoring, …), not delivery batches. Routing rule for new work: *does it give
  the user a new capability?* If yes → new feature requirement (+ its one
  blueprint + work orders), `child_of` the product root. If no — bug fix,
  enhancement, polish, refactor, perf, debt — it's a WORK ORDER under the
  existing feature: amend that feature's blueprint via suggestions (refine/review
  agents, revision history) instead of authoring a new one, then cut work orders
  that `implements` that feature's details BLUEPRINT — never the requirement
  directly: context assembly resolves WO →implements→ blueprint →details→
  requirement, so a WO linked straight to a requirement assembles a degraded
  context (no requirement slot, no lineage, no root intent). Never create
  "Phase N — …" requirements; if a batch label is wanted, put it in work-order
  titles. Optional work-type convention: prefix WO titles with `[bug]`/
  `[refactor]`/`[perf]`/`[chore]` (promoting work-type to a first-class field is
  itself a future feature).

## Status
The thesis is proven and the product is built and tested end-to-end — treat the
areas below as existing infrastructure; don't re-implement them. The codebase is
organized as:

- `packages/core` — the `Store` interface + SQLite impl (`node:sqlite`), context
  assembly and lineage inheritance, graph helpers (feature tree, roots,
  readiness, gap/critical-path overlays, pulse), suggestions/revisions/edits,
  markdown export, the usage ledger, and the project registry.
- `packages/agents` — `ModelProvider` (+ Anthropic impl with model tiering) and
  the authoring agents: draft, extract, refine (chat), review.
- `packages/mcp-server` — the streamable-HTTP MCP bridge (bearer auth + seed
  script): `list_ready_work_orders`, `get_work_order` (returns lineage and
  records a context receipt on delivery), `update_work_order_status`.
- `packages/cli` — `kiln create|link|draft|suggestions|accept|extract|review|
  status|show|export|projects`.
- `apps/desktop` — a Tauri v2 shell over a Hono sidecar (owns the active `Store`
  and the model key) and a React/Vite webview. Views: Pulse (home dashboard),
  Documents (navigator + CodeMirror editor with suggestion decorations), Board,
  and X-ray (whole-graph map), plus Settings (AI key + usage, authoring skills).
  A Context Inspector surfaces the exact context an agent is handed.

Capability features (children of the "Kiln" product root) include: X-ray, Pulse,
Board, Context Inspector, Navigator, Document editor & suggestions, Markdown
export, Agent-assisted authoring, Agent handoff over MCP, Context assembly &
inheritance, Projects (multiple isolated stores), AI settings & usage, Authoring
skills, and an opinionated authoring methodology.

For the durable design, read `docs/` (PRD, blueprint, CONNECTING,
authoring-methodology); for the work-order execution loop, read
`skills/kiln-execute/SKILL.md`.

### Store location
Every entry point (CLI, MCP server + seed, desktop sidecar) resolves the store
through `resolveDbPath()` in `packages/core/src/db/db-path.ts`: `KILN_DB_PATH` if
set (absolute paths only), else the project registry's active store, else
`~/.kiln/kiln.db` (parent dir auto-created). Projects are one SQLite file each,
listed in `~/.kiln/projects.json`.

The CLI: `pnpm -C packages/cli kiln -- <command>` (or
`node --experimental-sqlite packages/cli/dist/index.js <command>`); store defaults
to `~/.kiln/kiln.db`, override with `KILN_DB_PATH`.

## Commands
- Test all:  `pnpm -r test`   (or `pnpm -C packages/<pkg> test`)
- Typecheck: `pnpm -C packages/<pkg> typecheck`
- Build all: `pnpm -r build`
- Serve MCP: `KILN_MCP_TOKEN=<secret> pnpm -C packages/mcp-server start`
- Seed demo: `pnpm -C packages/mcp-server seed`
- (both use `~/.kiln/kiln.db` unless `KILN_DB_PATH` is set — absolute paths only)

## Environment
- Node 22.5+. The store uses the built-in `node:sqlite`, loaded in
  `packages/core/src/db/connect.ts`. On Node 22.x it needs `--experimental-sqlite`
  (the test runner sets this); on Node 24+ it is stable. Swapping to `better-sqlite3`
  is a drop-in change confined to `connect.ts`.

## Watch out
- The MCP SDK's transport and auth API moves fast. `packages/mcp-server` was built and
  verified against `@modelcontextprotocol/sdk` 1.29.0; if you upgrade it, re-check the
  streamable-HTTP and structured-output wiring against the installed type declarations
  rather than relying on memory. (Note: with `outputSchema`, success results must carry
  `structuredContent`.)
- When working with the model provider, check the current Anthropic API docs for
  structured-output/tool-use patterns rather than relying on memory.
