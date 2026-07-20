# Kiln — Requirements (Feature Requirements Documents)

Each feature below is written as a **user story** plus **acceptance criteria**. Acceptance
criteria are the contract: a feature is done when every criterion is verifiably true. Each
FRD links to its blueprint section (`blueprint.md`) and its work orders (`work-orders.md`).

---

## FRD-1 — Knowledge graph store

**Blueprint:** BP-1 · **Work orders:** WO-02, WO-03, WO-04

**Description.** The persistence and domain layer. Stores four entity types (artifact,
requirement, blueprint, work order), typed links between them, pending suggestions, and
immutable revisions — all in local SQLite, all behind a `Store` interface so no consumer
touches SQL directly.

**User story.** As the builder, I want all my product knowledge stored as typed, linked
entities in one local database, so that intent, specs, and work are connected rather than
scattered across disconnected tools.

**Acceptance criteria.**
- The store persists entities of type `artifact`, `requirement`, `blueprint`, `work_order`,
  each with a stable id, a title, a document body, and timestamps.
- The store persists typed links between entities: `implements`, `details`, `references`,
  `child_of`, `depends_on`.
- Requirements can nest via `child_of`, forming a feature tree; the store can return a
  requirement's direct children and its full subtree.
- A `blueprint` links to exactly one `requirement` via `details` (one-to-one enforced at the
  application layer).
- Work orders carry a `status` of `draft | ready | in_progress | done | cancelled` and an
  optional `assignee`.
- All access goes through a `Store` interface; the default implementation is SQLite with
  WAL mode enabled and foreign keys on, so two processes (app + MCP server) can read/write
  the same file concurrently.
- Artifacts are full-text searchable.
- All inputs crossing into the store are validated (Zod); invalid data is rejected before
  persistence, never written.

---

## FRD-2 — Context assembly

**Blueprint:** BP-2 · **Work orders:** WO-05

**Description.** The graph-traversal layer, and the single most important function in the
product: given a work order, assemble its complete linked context.

**User story.** As a coding agent, I want a work order delivered with its full linked
context — the blueprint it implements, the requirement that blueprint details, and the
artifacts that requirement references — so I can implement it correctly without hunting for
the "why."

**Acceptance criteria.**
- `assembleWorkOrderContext(id)` returns the work order plus: the blueprint it `implements`,
  the requirement that blueprint `details`, and every artifact that requirement
  `references`.
- If any expected link is missing (e.g. an unlinked work order), the function returns a
  clearly-typed partial result rather than throwing.
- Feature-tree traversal helpers return a requirement's ancestors and descendants correctly,
  including deep nesting.
- Assembly is covered by tests against seeded fixtures that assert the exact assembled shape.
- Assembly performs no writes and is safe to call from a read-only context.

---

## FRD-3 — MCP work-order bridge

**Blueprint:** BP-3 · **Work orders:** WO-06, WO-07

**Description.** A standalone MCP server that exposes ready work orders (with assembled
context) to any MCP-capable coding agent, and lets that agent report status.

**User story.** As the builder, I want to connect my coding agent to Kiln so it can pick up
the next ready work order with full context and mark it in progress or done, closing the
loop between planning and execution.

**Acceptance criteria.**
- The server exposes three tools:
  - `list_ready_work_orders` → work orders whose status is `ready` (id, title, summary).
  - `get_work_order(id)` → the full assembled context from FRD-2.
  - `update_work_order_status(id, status)` → transitions a work order's status.
- The server reads and writes the same SQLite store as the app (no separate data copy).
- Connecting Claude Code (or another MCP client) to the running server exposes the three
  tools and they are callable.
- Status transitions are validated against the allowed set; invalid transitions are
  rejected with a clear error.
- The server requires a bearer token supplied in the client's MCP config; unauthenticated
  calls are refused.
- A documented seed script produces a sample chain (artifact → requirement → blueprint →
  work order) so the loop can be demonstrated immediately.

---

## FRD-4 — Agent-assisted authoring

**Blueprint:** BP-4 · **Work orders:** WO-08, WO-09, WO-10, WO-11, WO-12

**Description.** The authoring intelligence: draft requirements and blueprints from
artifacts, extract work orders from blueprints, and represent every change as a structured,
per-operation accept/reject suggestion. Model access is abstracted behind `ModelProvider`.

**User story.** As the builder, I want an agent to draft my requirements and blueprints from
my source material and propose work orders from my blueprints, presenting each change as an
accept/reject suggestion, so I stay in control while moving fast.

**Acceptance criteria.**
- All model calls go through a `ModelProvider` interface; an Anthropic implementation is
  provided; the model used for drafting vs. lightweight tasks is configurable (tiering).
- The **drafting agent** takes a target document plus referenced artifacts and returns a
  `Suggestion`: an ordered list of typed edit operations (`insert | delete | replace`)
  against document anchors — never a freeform overwrite.
- Every returned suggestion is schema-validated (Zod); a malformed suggestion is rejected
  before it can touch a document.
- The builder can accept or reject the suggestion **per operation**; accepting applies the
  ops atomically and writes a new revision.
- The **extraction agent** takes a blueprint and returns candidate work orders as
  suggestions; accepted work orders are automatically linked (`implements`) to that
  blueprint.
- Drafting is guided by a customizable template/system prompt (the house style for a "good"
  requirement / blueprint).
- A CLI can run a draft or extraction and accept/reject results at the terminal, making the
  full loop usable without the GUI.

---

## FRD-5 — Local workspace app

**Blueprint:** BP-5 · **Work orders:** WO-13, WO-14, WO-15, WO-16

**Description.** A local desktop application that makes authoring and the loop pleasant: a
feature-tree navigator, a document editor that renders suggestions as red/green decorations,
and a work-order board.

**User story.** As the builder, I want a single app where I can see my feature tree, edit
documents, accept or reject the agent's suggestions inline, and move work orders to ready —
without writing SQL or living in a terminal.

**Acceptance criteria.**
- The app runs locally as a desktop application and reads/writes the same `core` store
  (through a bundled local service).
- A navigator shows the feature tree (nested requirements) and lets the builder open any
  requirement, blueprint, or artifact.
- Artifacts can be uploaded and appear as referenceable context.
- The document editor renders pending suggestions inline: insertions in green, deletions
  struck through in red, each individually acceptable or rejectable.
- A work-order board shows work orders by status, lets the builder set `ready` and assign,
  and displays each work order's linked blueprint and requirement.
- No product logic lives in the app; it calls `core` through the local service only.

---

## FRD-6 — Production-ready workspace UI

**Blueprint:** BP-6 · **Work orders:** WO-17 … WO-24

**Description.** Elevate the MVP workspace from functional to production-quality: a shared
design system, restructured navigation (top bar + unified navigator), complete entity
workflows (rename, blueprint creation, quick-open), and a polished board. No new domain
concepts — this feature makes the existing graph fully reachable and pleasant to operate.

**User story.** As the builder, I want the workspace to feel like a finished product —
consistent controls, a navigable hierarchy, discoverable status — so that daily authoring
and review is fast and no part of the knowledge graph is reachable only by side paths.

**Acceptance criteria.**
- All UI controls render from a shared token/primitive layer; no component defines ad-hoc
  colors, font sizes, or native unstyled inputs.
- A slim top bar hosts the view switcher, global quick-open, and connection/credential
  status; the left sidebar is purely a navigator.
- The navigator shows the full chain — requirements with nested blueprints and work orders,
  type-badged — plus a collapsible artifacts section; tree rows support expand/collapse,
  rename, delete, and add-child in place.
- Every entity is reachable both by navigation and by fuzzy quick-open (⌘K).
- Entities can be renamed in place; a blueprint can be created from a requirement in the UI
  (respecting the 1:1 `details` rule).
- The board fits the default window without cutting off columns; cards open their work
  order's document; status changes still come only from the sidecar's transition set.
- Async failures surface as human messages (e.g. "no model credentials configured"), never
  raw error strings; empty states guide the next action instead of showing bare "none".
