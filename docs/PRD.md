# Kiln — Product Requirements Document (MVP)

> **Working name — rename freely.** "Kiln" is a placeholder used consistently across
> these docs (repo name, package prefix). Find-and-replace to your real name later.

---

## 1. Summary

Kiln is an open-source, AI-native SDLC tool. It keeps a single **knowledge graph** that
links product intent → requirement → technical blueprint → work order, and it hands coding
agents (Claude Code, Cursor) **fully-contextualized work orders over MCP**.

It is deliberately *not* a coding tool. It sits *upstream* of coding agents. Its job is to
make sure that when an agent picks up a unit of work, it receives the complete chain of
"what" and "why" behind it — the linked requirement, blueprint, and source artifacts — in a
single call, and can report status back.

## 2. Problem

Coding agents are capable but context-starved and unaccountable at the project level.
Intent lives in a transcript, specs in a doc, tickets in a tracker, and code in a repo —
none of it linked. Agents get thin tickets stripped of rationale, humans lose the thread
between a shipped change and the intent that motivated it, and nobody can trace a line from
business goal to code. The bottleneck is not model capability; it is context assembly,
linkage, and accountability.

## 3. What the MVP proves (the thesis)

> A coding agent can pull a **ready** work order over MCP and receive the full linked
> `intent → requirement → blueprint → artifacts` context in one call, and report status
> back — and a human can author that chain with agent assistance behind accept/reject gates.

If that loop feels good, everything else (multiplayer, cloud, enterprise features) is
additive. If it doesn't, no amount of UI polish saves it. So the MVP is scoped to prove
exactly this and nothing more.

## 4. Personas

- **Builder (primary user).** A solo founder-engineer or small-team lead. Authors
  requirements and blueprints (with agent help), extracts work orders, and gates everything
  via accept/reject. Runs the whole loop locally.
- **Coding agent (consumer, not a human).** Claude Code / Cursor, connected over MCP. Reads
  ready work orders with full context, and updates their status. Never authors intent.
- **Deferred:** dedicated PM / architect / QA / multi-person teams. Out of scope for MVP;
  the architecture leaves seams for them.

## 5. Core concepts (domain vocabulary)

| Concept | Meaning |
|---|---|
| **Artifact** | Uploaded context: a transcript, spec, note, or file. Read-only source material. |
| **Requirement** | A feature's "what/why" — a user story plus acceptance criteria. Requirements nest into a **feature tree**. |
| **Blueprint** | A feature's "how" — the technical/architectural implementation plan. **One-to-one** with a requirement. |
| **Work order** | A unit of work for a developer/agent. Links to its blueprint (and through it, its requirement and artifacts). |
| **Link** | A typed edge between two entities. The links *are* the knowledge graph. |
| **Suggestion** | A proposed edit to a document, expressed as an ordered list of typed operations, that a human accepts or rejects per-operation. |
| **Revision** | An immutable snapshot written each time a suggestion is accepted — version history for free. |

The linkage that matters most:
`work_order --implements--> blueprint --details--> requirement --references--> artifact`,
plus `requirement --child_of--> requirement` (the tree) and
`work_order --depends_on--> work_order` (sequencing).

## 6. MVP scope — features

| ID | Feature | One-liner | Blueprint |
|---|---|---|---|
| **F1** | Knowledge graph store | Typed entities + links + suggestions + revisions in local SQLite, behind a `Store` interface. | BP-1 |
| **F2** | Context assembly | Traverse the graph; assemble a work order's full linked context in one call. | BP-2 |
| **F3** | MCP work-order bridge | Expose ready work orders (with assembled context) to coding agents over MCP. | BP-3 |
| **F4** | Agent-assisted authoring | Draft requirements/blueprints and extract work orders as structured, accept/reject suggestions. | BP-4 |
| **F5** | Local workspace app | Desktop UI: feature tree, document editor with suggestion decorations, work-order board. | BP-5 |

Full requirements (user stories + acceptance criteria) are in `requirements.md`.

## 7. Non-goals (explicitly out of scope for the MVP)

- **Validator / feedback module.** No in-app feedback collection.
- **Codebase indexing & bidirectional sync.** No GitHub integration, no "sync blueprints
  with code," no drift detection.
- **Multiplayer / real-time collaboration.** Single user, single local workspace.
- **Enterprise layer.** No SSO/SCIM, RBAC, or audit log. Seams are defined (`AuthProvider`,
  `Authorizer`, `AuditSink`) but only the basic local implementations ship.
- **Cloud / multi-tenant / Postgres.** SQLite, local, single-tenant only. The `Store`
  interface keeps the Postgres path open; it is not built.
- **Commercial packaging.** No `ee/` directory, no license-key gating. Not needed to prove
  the thesis.
- **System-diagram (C4) blueprints, comments, and rich version-history UI.** Deferred.

## 8. Success criteria (testable)

1. **The loop works headless.** With a seeded chain in the store, a connected coding agent
   calls `get_work_order`, receives the linked requirement + blueprint + artifacts as one
   payload, implements it, and calls `update_work_order_status` to mark it done — verified
   end-to-end.
2. **Context is complete.** `assembleWorkOrderContext(id)` returns the work order and every
   correctly-linked ancestor with zero manual stitching; covered by passing tests.
3. **Authoring is gated.** Every agent-drafted change surfaces as a suggestion the builder
   can accept or reject per-operation; accepting writes a revision.
4. **Extraction is real.** Given a blueprint, the extraction agent proposes work orders that
   are automatically linked to that blueprint and its requirement.
5. **(UI phase) It's usable.** The builder can navigate the feature tree, edit a doc, act on
   suggestions, and move a work order to `ready` — all from the app, no SQL.

## 9. Build phases

The work orders are sequenced so risk is retired first.

- **Phase 1 — Spine (F1–F3).** The knowledge graph, context assembly, and MCP server. Ends
  with the end-to-end agent demo. *Build and prove this before anything else.*
- **Phase 2 — Authoring (F4).** Model provider, structured-edit engine, drafting and
  extraction agents, and a small CLI. **← Natural MVP cut line: fully usable headless.**
- **Phase 3 — Workspace app (F5).** The Tauri desktop app that makes the loop pleasant and
  adoptable.

## 10. Constraints & principles

- **Local-first, single-user, SQLite.** No hosting, no accounts.
- **`core` is framework-free.** All logic lives in a pure TypeScript library. The desktop
  app, the (future) server, and the MCP server are *thin hosts* that import `core`.
- **Seams present, implementations deferred.** `Store`, `AuthProvider`, `Authorizer`,
  `AuditSink`, `ModelProvider` are interfaces from day one. Only basic impls ship.
- **Model-agnostic.** All model calls go through `ModelProvider`; the Anthropic impl is
  first, swapping providers is a config change.
- **Structured edits only.** Agents never overwrite documents; they emit validated
  operation lists that apply deterministically and produce revisions.
