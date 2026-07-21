---
name: kiln-execute
description: >
  Execute a Kiln work order over the kiln MCP server. Use when asked to "work
  the board", "pick up a work order", or implement anything tracked in Kiln —
  whenever the mcp__kiln__* tools are available and the task is a Kiln work
  order. Covers picking, claiming, scoping, implementing, verifying, and
  reporting status.
---

# Executing a Kiln work order

Kiln hands you a **work order**: one implementable unit of work, linked to the
blueprint that designed it, the requirement that motivated it, and the source
artifacts behind that requirement. Your job is to implement exactly that unit,
verify it, and report status back — nothing more.

The whole tool surface is three calls:
`list_ready_work_orders` → `get_work_order` → `update_work_order_status`.
You never write documents through MCP; Kiln documents change only through
suggestions inside the Kiln app.

**Which project are you working in?** Kiln holds multiple isolated projects
(one store each); the MCP server binds to exactly ONE, resolved once at its
startup (`KILN_DB_PATH` > `--project`/`KILN_PROJECT` > the registry's default
project) and never changed at runtime — the human switching projects in the
desktop app does NOT move your server, so mid-work-order you cannot be yanked
onto another project. The server's startup log names the store file it serves;
if the human's request mentions a project and you are unsure your server is
bound to it, ask before picking work — everything you list, read, and close
happens in that one project.

## The loop

### 1. Pick

Call `list_ready_work_orders`. It returns only work orders that are **ready
AND unblocked** — every `depends_on` prerequisite already `done`. Trust it:

- Do not hunt for work elsewhere in the store.
- Empty list → say so and stop. Never invent work.
- Multiple entries → they are all safe to start; pick the first unless the
  human states a priority. Work **one order at a time**.

### 2. Read the full context

Call `get_work_order { id }`. The payload is the whole intent chain, and it is
**tiered** — consume it in this order:

- **Tier 1 — actionable. Read first, follow exactly:** `workOrder`,
  `blueprint`, `requirement`, `dependencies`. This is the task, its design,
  its acceptance criteria, and its sequencing.
- **Tier 2 — situational. Consult when relevant:** `artifacts`, and `lineage`
  entries nearest-ancestor-first. Ground truth for unclear wording and
  inherited constraints.
- **Tier 3 — background. Skim, never study:** the LAST `lineage` entry — the
  product root (Product Overview body + system-architecture `blueprint`). It
  explains the intent everything serves; it never overrides tier 1. If tier 3
  seems to conflict with the work order, that is a question for the human,
  not a license to widen scope.

| Tier | Field | What it is | How to use it |
|---|---|---|---|
| 1 | `workOrder` | The unit of work | **This body is your scope. All of it, only it.** |
| 1 | `blueprint` | The design it implements | The how: approach, seams, constraints |
| 1 | `requirement` | The intent behind the blueprint | The why — acceptance criteria live here |
| 1 | `dependencies` | Every `depends_on` target: `{id, title, status}` | Explains sequencing. If you were offered this order, they are all `done` — their deliverables exist; build on them instead of re-implementing them |
| 2 | `artifacts` | Sources behind the requirement (its own) | Ground truth when wording is unclear |
| 2–3 | `lineage` | Ancestor requirements up the tree, nearest first: `{requirement, artifacts, blueprint?}[]` | **Inherited intent.** When this work order sits under a nested requirement, `lineage` carries the higher-level requirements and the artifacts they reference (deduped, nearest wins), plus each ancestor's `details` blueprint when one exists. Read it as root intent — the "why" behind the "why". In a store with a product root, the LAST entry is the product itself (tier 3): its body is the Product Overview (vision, non-goals) and its `blueprint` the system architecture — treat both as constraints on your implementation. A leaf work order that ignores it can satisfy its own requirement while violating the parent's. `[]` at the top level. |

Missing links arrive as `null`/`[]`, never as errors. That is a degraded but
valid handoff — see failure paths.

### 3. Claim

`update_work_order_status { id, status: "in_progress" }` — **immediately, before
implementing**, so humans and other agents see the order is taken.

Transitions are enforced server-side: `draft→ready→in_progress→done`, plus
`any→cancelled`. Skipping a step is rejected with a message listing the legal
next states. Never fight this; it is the lifecycle working.

### 4. Restate scope

Before writing code, state in your own words:

- what the work order asks for (from its body),
- how you'll know it's done (acceptance criteria from the requirement +
  any verification notes in the work order body),
- what is explicitly out of scope (the blueprint and requirement are context,
  not extra tasks — other work orders own the rest).

If you cannot restate it precisely, that's ambiguity — stop and ask (below).

### 5. Plan, then implement

Plan the change first. Follow the host repo's conventions (its CLAUDE.md or
equivalent). Prefer small, tested increments. Stay inside the restated scope —
if you discover adjacent work worth doing, note it for the human; do not do it.

### 6. Verify

Check the result against each acceptance criterion and each verification note,
one by one. Run the repo's tests/typechecks/builds. If the change has a runtime
surface, exercise it for real — don't stop at green unit tests.

### 7. Report and close

`update_work_order_status { id, status: "done", report: { … } }` — **only
after verification passes**, and the completion report travels **in the `done`
call itself**. A `done` without a report is rejected and the order stays
`in_progress`; with one, the report is recorded atomically with the transition
as an immutable completion receipt (the result returns its
`completionReceiptId`). Fill it honestly:

- `summary` (required, non-blank) — what was built, in the work order's terms.
- `verification` (required, non-blank) — how it was proven, **with real
  output**: the actual test/typecheck results, the live check you ran.
  "Tests pass" alone is not verification.
- `commits`, `branch`, `filesTouched` (testimony — **always include when the
  work produced commits**) — the commit sha(s), the branch they landed on, and
  the files changed, recorded as given. Kiln never inspects the repo; your
  testimony IS the execution record, and downstream drift checks are built on
  it. The schema tolerates omitting these; you don't get to. A close with
  `commits: []` when a commit exists is an incomplete report — omit them only
  when the work genuinely produced no commits (e.g. investigation-only).

Values are stored verbatim (whitespace-only fields are rejected, nothing is
trimmed), so write for a reader with no chat history. Then tell the human the
same things: what was built, how it was verified, anything to review. If the
human works review-gated, present first and let them tell you to close — the
report still rides the eventual `done` call.

## Failure paths

**Ambiguous or underspecified work order** — stop and ask the human. Do not
improvise scope, do not guess between readings, do not silently narrow the
task. If already `in_progress`, leave it there and say why you stopped.

**Verification fails** — do not mark `done`. Report the failing output
honestly, keep the order `in_progress`, fix or ask.

**Close rejected — missing or invalid completion report** — a `done` call
without a `report`, with a blank `summary`/`verification`, or carrying a
report on any transition other than `in_progress → done` is refused. The
error names exactly what is wrong; no receipt is recorded and the status is
unchanged. Fix the report and repeat the `done` call — never pad a field just
to get past the gate.

**Missing context** (`blueprint`/`requirement` null, `artifacts` empty) —
proceed only if the work order body is self-contained enough to restate scope
and verification. Otherwise stop and ask for the missing link.

**Suspicious dependency** — `dependencies` all read `done` but a deliverable
you need is absent from the repo. Stop and ask; something upstream is wrong.

**Tool errors:**
- `401` — bearer token missing/wrong. Fix the MCP registration
  (`Authorization: Bearer <token>`), don't retry blindly.
- Connection refused — the server is down. Ask the human to start it
  (`KILN_MCP_TOKEN=<secret> pnpm -C packages/mcp-server start` in the Kiln repo).
- `Invalid status transition …` — you skipped a step or repeated one; the
  error names the legal next states. Follow them.

**Wrong or already-taken order** — a work order you shouldn't have claimed can
go `any→cancelled`; anything else needs the human. Don't "un-claim" by hacking
statuses.

## Non-negotiables

1. `in_progress` on pickup, `done` only after verification — never skip, never
   pre-announce.
2. The work order body is the scope. The rest of the payload is context.
3. When unsure, stop and ask. An honest stall beats a confident wrong build.
4. `done` always carries the completion report — a real summary and real
   verification output. If you cannot fill it truthfully, the work is not
   done.
5. If the work produced commits, the report carries them — `commits`,
   `branch`, `filesTouched`. Empty testimony beside a real commit is a
   false record.
