# Connecting a coding agent to Kiln

How to run the Kiln MCP server and drive the work-order loop from Claude Code
(or any MCP client that speaks streamable HTTP). This is the Phase-1 loop:
`list_ready_work_orders` → `get_work_order` → implement → `update_work_order_status`.

## 1. Build and seed

```sh
pnpm install
pnpm -r build

# Create (or reuse) a store and insert a demo chain:
#   artifact → requirement → blueprint → ready work order
# Prints the ready work order's id on stdout. The store resolves like every
# other entry point: KILN_DB_PATH if set, else the registry's default
# project, else ~/.kiln/kiln.db (see "Which project does the server serve?"
# in §2).
pnpm -C packages/mcp-server seed
```

> **Node 22.x:** the store uses the built-in `node:sqlite`, which needs the
> `--experimental-sqlite` flag. The package's `seed`/`start` scripts pass it for
> you. On Node 24+ no flag is needed.

## 2. Start the server

```sh
KILN_MCP_TOKEN=choose-a-secret \
KILN_MCP_PORT=3777 \
pnpm -C packages/mcp-server start
```

You should see:

```
kiln-mcp-server listening on http://127.0.0.1:3777/mcp (db: /Users/you/.kiln/kiln.db)
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `KILN_DB_PATH` | — | Absolute path to a SQLite file — the ultimate override; when set, the project registry is ignored entirely. Shared with the app (WAL makes this safe). |
| `KILN_PROJECT` | — | A registered project's id, slug, or exact name. Unknown values refuse to start (never a silently-wrong store). The `--project <ref>` argv flag is the same thing, and beats an inherited env value. |
| `KILN_MCP_TOKEN` | — (required) | Bearer token clients must present. Server refuses to start without it. |
| `KILN_MCP_PORT` | `3001` | HTTP port. |
| `KILN_MCP_HOST` | `127.0.0.1` | Bind address. Keep it loopback unless you know why not. |
| `KILN_MCP_ENDPOINT` | `/mcp` | HTTP path of the MCP endpoint. |

Every request without a valid `Authorization: Bearer <token>` header is refused
with `401` before it reaches any tool.

### Which project does the server serve?

Kiln supports multiple **projects** — fully isolated workspaces, one SQLite
file each, listed in `~/.kiln/projects.json` (the desktop app's switcher, the
CLI's `kiln projects` commands, and this server all read the same registry).
Every process resolves its store **once, at startup**, in this order:

1. `KILN_DB_PATH` — explicit file path, registry ignored.
2. `--project <id|slug|name>` / `KILN_PROJECT` — registry lookup; unknown
   refs are a startup error.
3. The registry's **default project** (the one the desktop app opened last).
4. No registry at all → the legacy `~/.kiln/kiln.db`.

The startup log names the resolved file — that line is how you confirm which
project a running server is bound to:

```
kiln-mcp-server listening on http://127.0.0.1:3777/mcp (db: /Users/you/.kiln/kiln.db)
```

Resolution is **per-process, never synchronized**. Switching projects in the
desktop app does NOT move a running MCP server (or CLI invocation) — an agent
mid-work-order stays on the project it started with, by design. Two caveats
that follow from this:

- App activation *promotes* that project to the registry default, so a server
  **restarted later** without an explicit `--project`/`KILN_PROJECT` will
  follow wherever the app last was. Pin the project explicitly if the server
  must always serve the same one.
- Removing a project (app or registry) only deletes its registry entry — the
  store file always survives on disk. Never assume removal freed data.

## 3. Register with Claude Code

```sh
claude mcp add --transport http kiln http://127.0.0.1:3777/mcp \
  --header "Authorization: Bearer choose-a-secret"
```

Verify the connection (this performs a real MCP handshake):

```sh
claude mcp list
# kiln: http://127.0.0.1:3777/mcp (HTTP) - ✔ Connected
```

Then start `claude` in your project. The three tools appear as
`mcp__kiln__list_ready_work_orders`, `mcp__kiln__get_work_order`, and
`mcp__kiln__update_work_order_status`.

Other MCP clients: any client that supports streamable HTTP works the same way —
point it at the URL and supply the `Authorization` header. With the TypeScript
SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3777/mcp"), {
    requestInit: { headers: { authorization: "Bearer choose-a-secret" } },
  }),
);
```

## 4. Run the loop

Ask the agent to work the board, or call the tools directly:

1. **`list_ready_work_orders`** → `{ workOrders: [{ id, title, summary }] }` —
   every work order that is `ready` **and unblocked**: a work order with any
   `depends_on` target not yet `done` is withheld even if its own status is
   `ready`, so an agent is never handed work whose groundwork is unfinished.
2. **`get_work_order { id }`** → the full assembled context:
   `{ workOrder, workType, guidance, blueprint, requirement, artifacts,
   dependencies, lineage }` — the complete
   `work_order → blueprint → requirement → artifact` chain in one
   call. Missing links come back as `null`/`[]`, never as errors. The payload
   fields:

   | Field | Shape | What it is |
   |---|---|---|
   | `workOrder` | entity | The unit of work. |
   | `workType` | `feature \| bug \| refactor \| perf \| chore` | The order's effective work type (unset resolves to `feature`). |
   | `guidance` | string | **Per-type execution discipline — tier-1, follow it while implementing** (e.g. bug → reproduce first and keep a regression test; refactor → no behavior change; perf → measure before/after and cite numbers in the report). Deterministic: derived purely from `workType`, never model-generated. |
   | `blueprint` | entity \| null | The blueprint it implements. |
   | `requirement` | entity \| null | The requirement that blueprint details. |
   | `artifacts` | entity[] | Artifacts the requirement references directly. |
   | `dependencies` | `{ id, title, status }[]` | Its `depends_on` targets. If you were offered this order, they are all `done`. |
   | `lineage` | `{ requirement, artifacts, blueprint? }[]` | **Inherited intent** — ancestor requirements up the `child_of` chain (nearest first), each with the artifacts it references. An artifact referenced at multiple levels appears once, at the nearest. `[]` for a top-level requirement. This is how a deeply-nested work order still sees root-level intent (a kickoff transcript or PRD referenced high in the tree) without the child re-referencing it. `blueprint` (Phase 14) is that ancestor's `details` blueprint when one exists — absent otherwise. In a store with a product root, the LAST lineage entry is the product itself: its body is the Product Overview and its `blueprint` the system architecture. Read tier-wise: nearest entries are situational context; the root entry is BACKGROUND — skim it, never let it override the work order (see the kiln-execute skill's reading order). |
3. Implement the work.
4. **`update_work_order_status { id, status, report? }`** — allowed transitions
   are `draft→ready`, `ready→in_progress`, `in_progress→done`, and
   `any→cancelled`. Anything else is rejected with a message listing the
   allowed next states, e.g.:

   ```
   Invalid status transition ready → done. Allowed from ready: in_progress, cancelled.
   ```

   So the agent marks the order `in_progress` when it starts and `done` when it
   finishes.

   **Closing `in_progress → done` REQUIRES a completion report** — the return
   half of the handoff loop. The context receipt recorded at `get_work_order`
   says what Kiln handed the agent; the completion receipt says what came
   back, as an immutable, append-only record tied to the work order. The
   `report` fields:

   | Field | Shape | Required | What it is |
   |---|---|---|---|
   | `summary` | string | yes — non-blank | What was built. |
   | `verification` | string | yes — non-blank | How it was proven, with real output (test results, live checks). |
   | `commits` | string[] | no (defaults to `[]`) | Testimony: the commits carrying the work. Recorded as given, never verified against a repository. |
   | `branch` | string | no | Testimony: the branch the work landed on. |
   | `filesTouched` | string[] | no (defaults to `[]`) | Testimony: the files changed. |

   The receipt is written atomically with the transition — both happen or
   neither does — and the receipt's id comes back in the result. Output shape:
   `{ workOrder, completionReceiptId? }`, where `completionReceiptId` is
   present exactly when a report was recorded (i.e. on `in_progress → done`).
   A compliant close:

   ```json
   {
     "id": "3f6d21aa-…",
     "status": "done",
     "report": {
       "summary": "Added the `completed` event kind to the Pulse activity timeline, sourced from completion receipts.",
       "verification": "pnpm -C packages/core test — all suites pass, incl. 4 new cases in pulse.test.ts; live: closed a WO over MCP and saw the completed event on the Pulse feed.",
       "commits": ["a1b2c3d Surface completed handoffs in Pulse"],
       "branch": "main",
       "filesTouched": ["packages/core/src/graph/pulse.ts", "packages/core/src/graph/pulse.test.ts"]
     }
   }
   ```

   The failure modes are loud, and none of them changes the status or records
   a receipt:

   - **`done` without a report:**

     ```
     Closing in_progress → done requires a completion report. Missing: report.summary (what was built) and report.verification (how it was proven, with real output). Optional testimony: report.commits, report.branch, report.filesTouched. The status is unchanged.
     ```

   - **A report on any other transition** (it travels only on the close):

     ```
     A completion report is only accepted when closing in_progress → done; this is ready → in_progress. No receipt was recorded and the status is unchanged.
     ```

   - **A blank field** — empty and whitespace-only `summary`/`verification`
     are rejected (values are stored verbatim, never trimmed):

     ```
     Invalid completion report — no receipt recorded, status unchanged: report.summary: summary must not be empty or whitespace-only
     ```

## 5. Install the execution skill

The repo ships a skill that teaches a coding agent the execute-a-work-order
procedure — pick only unblocked ready orders, read the full context, restate
scope, implement, verify against the acceptance criteria, and keep status
discipline (`in_progress` on pickup, `done` only after verification, with the
completion report carried in the `done` call itself):
[`skills/kiln-execute/SKILL.md`](../skills/kiln-execute/SKILL.md).

**Claude Code** — copy it where the agent discovers skills, either per-project
or personal:

```sh
# per-project (checked into the consuming repo)
mkdir -p .claude/skills && cp -r <kiln>/skills/kiln-execute .claude/skills/

# or personal (all projects on this machine)
mkdir -p ~/.claude/skills && cp -r <kiln>/skills/kiln-execute ~/.claude/skills/
```

The agent then loads it whenever it works the Kiln board (the frontmatter
`description` is the trigger).

**Cursor / other agents** — the body is plain markdown with no Claude-specific
syntax: paste it into `.cursor/rules/kiln-execute.mdc` (or your agent's
equivalent rules file), dropping the YAML frontmatter.

## 6. Authoring skills (customizable house standards)

The AUTHORING agents (draft, extract, refine chat, review) — not the MCP
execution loop — can be tuned per store with **authoring skills**:
settings-managed documents whose bodies state your structure, style,
terminology, and conventions. Skills are app configuration, not knowledge:
they live in the `kiln.authoring.skills` setting as an ordered JSON array of
`{ id, title, body, enabled }` documents (array order = injection order,
`enabled` = the switch), are created/viewed/edited ONLY under **Settings →
Blueprint Writing** (which fronts `GET/PUT /settings/authoring-skills` on the
sidecar), and never appear in the knowledge graph, the navigator, Quick Open,
or export. The settings value is the single current version — skill edits
carry no revision history (a deliberate trade-off of leaving the graph;
reversed from the first delivery, which stored skills as artifact entities).

Enabled skills are injected at system-prompt strength into every draft,
extract, chat, and review call — a dedicated "Authoring skills (house
standards — follow these)" section ahead of the assembled context, resolved
once in core (`resolveAuthoringSkills`) and shared by the sidecar and CLI. A
skill may also declare a per-type template that replaces the built-in
`methodology-*` draft structure verbatim: a `## Template: requirement`,
`## Template: blueprint`, or `## Template: work-order` heading followed by the
template in a code fence (unfenced, the template runs to the next
`## Template:` heading or end of body; the first enabled skill in order
declaring a type wins). With zero enabled skills, every agent output path is
byte-identical to the built-in behavior — the house methodology and templates
are the fallback, not a casualty.

## Verified run (WO-07)

This exact sequence was executed against a seeded store on 2026-07-06 with
Claude Code 2.1.199 (registration + handshake) and the MCP SDK client v1.29.0
(tool calls):

| Step | Result |
|---|---|
| `claude mcp add` + `claude mcp list` | `kiln … ✔ Connected` |
| `list_ready_work_orders` | 1 ready order: “Wire up the three MCP tools” |
| `get_work_order` | Full chain: blueprint “MCP work-order bridge”, requirement “Traceable work handoff”, artifact “Kickoff transcript” |
| `update_work_order_status → done` (from `ready`) | Rejected: must pass through `in_progress` |
| `→ in_progress`, then `→ done` | Both accepted |
| `list_ready_work_orders` | Empty — the board is clear |
| Re-open store in a fresh process | Work order status is `done` |

**This closes Phase 1: a coding agent pulled a ready work order with its full
intent chain over MCP and reported completion back to the shared store.**
