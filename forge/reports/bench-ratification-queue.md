**10 provisional** across 1 feature(s): **10 clean**, **0 flagged**.

# Ratification queue — distilled decisions (provisional)

## Kiln Survey Benchmark — 10 decision(s)
- ✓ **[design] Sidecar owns the store and model key; the webview is a pure client** (governs 0 task(s))
   - The desktop app splits into a Tauri shell, a React webview, and a Hono sidecar, with the sidecar holding both the SQLite store and the model key so the webview never touches persistence or credentials.
   - evidence: "the sidecar owns   the store and the model key, the webview is a pure client"
- ✓ **[constraint] Authoring agents emit suggestions only** (governs 0 task(s))
   - All four authoring agents (draft, extract, refine, review) produce suggestions rather than writing entities directly, keeping every agent output behind the human gate.
   - evidence: "draft/extract/refine/review authoring agents; all emit suggestions only"
- ✓ **[design] Persistence via the Store interface over node:sqlite** (governs 0 task(s))
   - Core exposes a Store interface implemented over SQLite using the built-in node:sqlite driver; consumers depend on the interface, not the database.
   - evidence: "the Store interface over SQLite (node:sqlite)"
- ✓ **[design] MCP bridge is streamable HTTP with bearer auth** (governs 0 task(s))
   - The MCP server speaks streamable HTTP and refuses requests without a bearer token, exposing the work-order loop plus propose_feature.
   - evidence: "streamable-HTTP MCP bridge with bearer auth"
- ✓ **[design] The CLI owns filesystem side effects for export** (governs 0 task(s))
   - Filesystem writes for the markdown export live in the CLI package rather than in core, keeping core free of host side effects.
   - evidence: "packages/cli — authoring/ops commands; owns filesystem effects for export"
- ✓ **[constraint] No SQL outside core's store/db layers** (governs 0 task(s))
   - Dialect-specific SQL is confined to core's store and db modules; no other package or layer issues queries directly.
   - evidence: "No SQL outside core's store/db layers"
- ✓ **[constraint] Zod validation at every boundary** (governs 0 task(s))
   - Inputs crossing any boundary are Zod-validated before they reach persistence or business logic.
   - evidence: "No SQL outside core's store/db layers; Zod at every boundary"
- ✓ **[constraint] Derived views are deterministic pure functions** (governs 0 task(s))
   - Views computed from the graph (readiness, tree, pulse, export and the rest) are pure, deterministic functions of the store, never stored state.
   - evidence: "derived views are deterministic pure functions"
- ✓ **[constraint] Agent output enters the store only as human-gated suggestions** (governs 0 task(s))
   - No agent path commits content directly; everything an agent produces lands as a suggestion a human resolves.
   - evidence: "agent output enters the store only as human-gated suggestions"
- ✓ **[constraint] Store resolution happens once at startup with a fixed precedence** (governs 0 task(s))
   - Every entry point resolves its store exactly once at process start, using the precedence KILN_DB_PATH, then explicit project, then the registry default — never re-resolving at runtime.
   - evidence: "every entry point resolves its store once at startup (KILN_DB_PATH > project > registry default)"