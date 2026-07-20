# Kiln

An AI-native SDLC tool that keeps a knowledge graph linking
**intent → requirement → blueprint → work order**, and hands coding agents
fully-contextualized work orders over MCP. A coding agent calls `get_work_order`
and receives the whole chain — plus lineage up to root intent — in a single call,
then reports status back to the same store the human works in.

The system is a set of TypeScript packages (`core`, `agents`, `mcp-server`, `cli`)
plus a Tauri + React desktop app (`apps/desktop`). See [`docs/`](docs) for the
design (PRD, blueprint, CONNECTING, authoring-methodology).

## Requirements

- **Node 22.5+** (uses the built-in `node:sqlite`). On Node 22.x this needs the
  `--experimental-sqlite` flag; the test runner and package scripts set it for you.
  On **Node 24+** `node:sqlite` is stable and the flag is unnecessary.
- pnpm.

## Quickstart

```bash
pnpm install
pnpm -r build
pnpm -r test

# Seed a demo chain (artifact → requirement → blueprint → ready work order)
# The store defaults to ~/.kiln/kiln.db everywhere (CLI, MCP server, desktop app);
# set KILN_DB_PATH to an absolute path to use a different file.
pnpm -C packages/mcp-server seed

# Serve it to coding agents over MCP
KILN_MCP_TOKEN=choose-a-secret pnpm -C packages/mcp-server start
```

Then register with Claude Code and run the loop — full steps in
[`docs/CONNECTING.md`](docs/CONNECTING.md).

## Layout

```
packages/core/src/
├─ domain/         types.ts · edits.ts (EditOp/Suggestion) · schemas.ts (Zod input)
├─ db/             connect.ts  (node:sqlite, lazy-loaded; pragmas, schema DDL)
├─ store/          store.ts (interface) · sqlite-store.ts (impl) · *.test.ts
├─ graph/          context.ts (context assembly) · tree.ts (featureTree) · *.test.ts
├─ edits/          apply.ts (applyOp/applySuggestion + revisions) · *.test.ts
├─ transitions.ts  work-order status lifecycle (shared by MCP bridge + app)
└─ errors.ts

packages/mcp-server/src/
├─ index.ts        CLI entry (env config, HTTP listener)
├─ server.ts       streamable-HTTP wiring + bearer-auth gate
├─ tools.ts        the three MCP tools over Store
├─ auth.ts         bearer-token check (constant-time)
├─ seed.ts         demo-chain seeder (also a CLI)
└─ *.test.ts
```

## The one thing this proves

A coding agent can call `get_work_order` and receive the whole
`work_order --implements--> blueprint --details--> requirement --references--> artifact`
chain in a single MCP call, then report status back to the same store the human works in.
Missing links yield typed partials, never throws.

## Design notes

- **Everything goes through `Store`.** No consumer imports the driver or writes SQL — all
  dialect-specific SQL (FTS5, the recursive CTE) is confined to `SqliteStore`. That's what
  keeps a future `PostgresStore` (for the hosted tier) a drop-in. The MCP server obeys the
  same rule: it only sees the `Store` interface.
- **Two processes, one file.** The app and the MCP server share the SQLite file; WAL +
  `busy_timeout` make that safe.
- **Driver choice.** The scaffold uses Node's built-in `node:sqlite` (zero native build).
  `better-sqlite3` is a drop-in alternative — same API shape — if you prefer no experimental
  flag; the swap is confined to `db/connect.ts`.
- **Status lifecycle** is enforced server-side: `draft→ready→in_progress→done`, plus
  `any→cancelled`. Invalid transitions return a tool error listing the allowed next states.
- **IDs** are `crypto.randomUUID()`. Swap for ULID if you want lexicographically sortable ids.
- **Structured edits** are modeled (`EditOp`/`Suggestion`) and applied via
  `applySuggestion` (`core/src/edits`): accepted ops apply atomically and append a
  revision. Anchors must match exactly once; an empty insert anchor appends.
```
