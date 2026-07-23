---
name: kiln-survey
description: >
  Survey an existing repository into an empty Kiln project over the kiln MCP
  server. Use when asked to "survey this repo into Kiln", "bootstrap Kiln from
  this codebase", or extract requirements/blueprints from existing code —
  whenever the mcp__kiln__propose_feature tool is available and the target is
  a fresh Kiln project. Covers surveying the code, synthesizing a product
  overview and feature tree, proposing features as gated suggestions, and
  handing review to the human.
---

# Surveying a repository into Kiln

You are bootstrapping a **living source of truth** from code that was never
built inside Kiln. You read the repository (you are the one with filesystem
access — Kiln never reads repositories), synthesize a product overview and a
feature tree, propose the root documents with `propose_root_overview`, and
propose each feature with `propose_feature`.

Both are **gated writes**: your proposed bodies land as **pending
suggestions** (`propose_feature` on the empty-bodied requirement and blueprint
it creates; `propose_root_overview` on the seeded root pair). A human accepts
or rejects every document in the Kiln app. Nothing you propose becomes real
until they do — and that gate is the point, not an inconvenience. You never
accept, and you never propose anything you cannot cite code for.

**Which project are you proposing into?** The MCP server binds to exactly ONE
project, resolved once at its startup (`KILN_DB_PATH` > `--project`/
`KILN_PROJECT` > the registry's default project) and never changed at runtime.
The server's startup log names the store file it serves. A survey lands dozens
of entities — pointed at the wrong project it pollutes a real store. Confirm
with the human that the server is bound to the fresh project created for this
survey **before proposing anything**.

## Preconditions

1. The `mcp__kiln__*` tools are available and authenticated (any tool call
   answering, rather than 401/refused, proves both).
2. The target is a **fresh Kiln project** created for this survey (app: New
   Project; CLI: `kiln projects create <name>`). Creation seeds two documents:
   a product-root requirement (title = project name, empty body) and a
   `<name> system architecture` blueprint linked `details` → root. That is all
   a fresh project contains.
3. The project is not already populated — see the survey-safety check in
   step 1 below. v1 bootstraps empty projects only; re-surveying a populated
   graph is explicitly out of scope. If in doubt, stop and ask.

## The procedure

### 1. Confirm the target project

Ask the human (or confirm from their request) which project the server is
bound to and that it was freshly created for this survey. Then run the
populated-project check:

- Call `list_ready_work_orders`. A fresh project has no work orders, so any
  entry proves the project is populated → **warn and stop**.
- The MCP surface deliberately has no entity listing, so this check is
  partial; the human's confirmation that the project is fresh is part of the
  precondition, not a formality.

### 2. Survey the repository — evidence before invention

Read the code the way a new senior engineer would, collecting evidence as you
go. In rough order:

- **Entry points** — package manifests (`package.json`, `pyproject.toml`,
  `Cargo.toml`, …), `main`/`bin` targets, HTTP routers, CLI command tables,
  app shells. These enumerate what the software actually exposes.
- **Architecture** — directory layout, build config, how the pieces talk
  (imports across packages, ports, IPC). You need this for the root design
  doc and for each feature's blueprint.
- **Docs** — README, `docs/`, comments that state intent. Treat docs as
  claims to verify against code, not as truth.
- **Tests** — they encode intended behavior and edge cases; a well-tested
  path is strong evidence of a deliberate capability.

For every capability you think you see, capture **evidence excerpts**: the
repo-relative file paths, short verbatim quotes (a few lines each, not whole
files), and one or two sentences of your own rationale connecting them. These
become the evidence artifacts. A capability you cannot evidence this way does
not go in the tree.

### 3. Synthesize the product overview and the feature tree

- **Product overview** — what the product is, who it serves, the problems it
  solves, core capabilities, and observed non-goals/constraints. Written for
  a reader who has never seen the repository.
- **System architecture summary** — components, data flow, technology stack
  and why, conventions the code visibly enforces.
- **Feature tree** — the capabilities a *user* of the software would name,
  each one feature: requirement + blueprint per the templates below. A
  feature is a capability the user gains, not a directory, a package, or a
  layer. A small repository typically yields 3–12 features; do not enumerate
  every module. Keep the tree shallow — features directly under the product
  root; propose sub-features only when a capability clearly decomposes and
  the parent stands on its own.

### 4. Propose the root documents

Call `propose_root_overview` **once**, with your product overview and
system-architecture summary (and optional overview-level evidence — README
and manifest excerpts, typically). It is the same gate as the feature
proposals: the overview lands as a pending suggestion on the product root
requirement and the architecture summary as one on the seeded architecture
blueprint; the seeded titles stay; nothing is committed until the human
accepts in the app.

The call refuses loudly unless the root pair is **pristine** — the root body
empty and the architecture blueprint still the seeded fill-in template, with
no pending suggestions on either. A refusal naming a non-empty body or an
edited template is a populated-project signal: stop and ask (v1 has no merge
semantics — the human edits the existing documents in the app instead).

Do this before or alongside the feature proposals; neither blocks the other.

### 5. Propose features — top-down, one per call

Call `propose_feature` once per feature, **parents before children**:

- Features directly under the product root: **omit `parentRequirementId`** —
  the server resolves the single parentless product root automatically.
- Sub-features: pass `parentRequirementId` = the `requirementId` returned by
  the parent's call. The parent exists as an entity even while its body is
  still an unreviewed suggestion, so this works — but remember a rejected
  parent orphans its children; another reason to keep the tree shallow.

One feature per call. Do not parallelize into the same parent blindly; land
them in tree order so a mid-survey stop leaves a coherent partial tree.

### 6. Handle rejections — fix, never weaken

A rejected proposal creates **nothing** (`Proposal rejected — nothing was
created`), and the error names every failing document and check at once. Fix
exactly what is named and retry the same feature. Never "fix" a rejection by
deleting evidence, padding a section with filler, or splitting a document
just to duck a size cap — if a body is over the cap, tighten the writing; if
evidence is missing, go find it in the code or drop the claim.

### 7. Report and stop

Tell the human: which features you proposed (titles + returned ids), that the
root overview and architecture summary await review as suggestions on the
root pair, anything you saw but did not propose (and why — usually
insufficient evidence), and that review happens in the Kiln app: accepting a
suggestion commits the body as the document's first revision; rejecting
discards it. **Your job ends at proposals.** You do not accept suggestions,
you do not nag for acceptance, and you do not cut work orders under
unaccepted features.

## The `propose_feature` contract

Input (one feature per call):

```jsonc
{
  "requirement":  { "title": "…", "body": "…" },   // per the requirement template
  "blueprint":    { "title": "…", "body": "…" },   // per the blueprint template
  "evidence":     [ { "title": "…", "body": "…" } ], // 1–20 artifacts
  "parentRequirementId": "…"                        // optional; omit for root features
}
```

Validation, all enforced server-side and reported together on rejection:

- Every title non-blank and ≤ 200 characters; every body non-blank and
  ≤ 20,000 characters.
- 1–20 evidence artifacts — **at least one is mandatory**: a proposal without
  evidence is an invention.
- The requirement body must contain a `Non-goals` heading (any `#` level).
- A feature proposed under the product root must have a
  `<Name> — <plain-language description>` title: name, space, em-dash (—),
  space, description.
- An explicit `parentRequirementId` must exist and be a requirement. When
  omitted: zero parentless requirements or more than one is an error (see
  failure paths).

What a successful call creates — atomically; a mid-write failure cleans up
after itself and leaves nothing half-created:

- A **requirement** and a **blueprint**, both created **empty-bodied**, linked
  `child_of` → parent and `details` → requirement.
- Your proposed bodies filed as **pending suggestions** on each — the gate.
- The evidence **artifacts** with their bodies committed directly (read-only
  source material needs no gate), each linked `references` ← requirement, so
  context assembly delivers the evidence to future work orders.

Result: `{ requirementId, blueprintId, artifactIds, suggestionIds }` —
`suggestionIds` is `[requirementSuggestionId, blueprintSuggestionId]`. Keep
the `requirementId` of anything that may become a parent.

## The `propose_root_overview` contract

One call per survey (step 4):

```jsonc
{
  "overview":     "…",                               // body for the product root requirement
  "architecture": "…",                               // body for the seeded architecture blueprint
  "evidence":     [ { "title": "…", "body": "…" } ]  // optional, 0–20 artifacts
}
```

No target id — the single parentless product root and its `details` blueprint
ARE the target, resolved server-side (zero or several parentless requirements
is an error, same as `propose_feature`). Validation, enforced server-side:

- `overview` and `architecture` non-blank and ≤ 20,000 characters; evidence
  titles ≤ 200 and bodies ≤ 20,000 characters; at most 20 evidence artifacts
  (none required — the per-feature proposals carry the mandatory evidence;
  the root documents are a synthesis of them).
- The overview must contain a `Non-goals` heading (any `#` level).
- The root pair must be **pristine**: root body empty, blueprint body empty
  or exactly the seeded template, no pending suggestions on either. Anything
  else is refused loudly and creates nothing.

What a successful call creates — atomically, compensating on failure:

- The overview as a **pending suggestion** on the root requirement and the
  architecture summary as one on the `details` blueprint (an insert on an
  empty body; a whole-body replace over the seeded template, so accepting
  swaps template for proposal). Titles are untouched; bodies stay uncommitted
  until the human accepts.
- Evidence artifacts (if any) with their bodies committed directly, each
  linked `references` ← the root requirement.

Result: `{ rootRequirementId, blueprintId, artifactIds, suggestionIds }` —
`suggestionIds` is `[overviewSuggestionId, architectureSuggestionId]`.

## House templates

These are the house standards the proposal checks are drawn from. Your
proposed bodies must follow them — you have no other source for them during a
survey, so they are embedded here in full.

### Feature requirement

A requirement states a **capability the user gains**, not a batch of work.
Title convention (a rule, not a habit): `<Name> — <plain-language description
of what it does>` — the feature's name, an em-dash, then a user-facing
description. A reader skimming the navigator should learn what the feature
does from the title alone. The body never restates the product context —
context assembly delivers the root overview to every nested document
automatically.

```
## Capability
One paragraph: what the user can do after this exists that they cannot do
today. Written in terms of the user, not the system.

## Why
The motivating problem or opportunity. Link evidence where it exists.

## Scope
Bulleted: what is IN. Each bullet is observable behavior, not implementation.

## Non-goals
Bulleted: what is explicitly OUT, especially things a reader would otherwise
assume are in. "None" is not acceptable — every feature has a tempting
adjacent scope it is declining.

## Success criteria
How we will know the capability works — observable, ideally demoable.
```

Complete when: the title follows `<Name> — <plain-language description>`; the
Capability paragraph names the *user's* new ability; at least one non-goal is
stated; success criteria are observable (a reader could verify without
asking); and the motivation is grounded in a `references` artifact — for a
survey, that is your evidence.

Survey note: for extracted features, Scope is what the code *observably does
today* and Success criteria are *already met* — state them as verifiable
behavior anyway ("exporting the graph produces one markdown file per
entity"), because they become the yardstick for future drift.

### Blueprint

A blueprint records **how and why**, for exactly one requirement. It is the
document a coding agent reads to make the dozens of small decisions a work
order doesn't spell out. Optimize for decisions, not prose. For a surveyed
feature, "Key decisions" records the decisions the existing code embodies —
where the code visibly rejected an alternative (a commented-out path, a
migration, an obvious road not taken), record it; where you can only infer,
say so honestly rather than inventing a rejection.

```
## Approach
The chosen design in one or two paragraphs. A reader should be able to
predict the shape of the diff from this section alone.

## Key decisions
For each consequential decision:
- **Decision** — what was chosen.
- **Alternatives rejected** — and the one-line reason. (This is the section
  that saves the next agent from re-litigating; do not skip it.)

## Affected components
Which packages / layers / files change, and which are explicitly untouched.
State the additive-vs-breaking character.

## Conventions & constraints
Rules the implementation must follow that the code can't express. Inherit
from the architecture blueprint by reference; state only deltas and
reinforcements.

## Verification strategy
How the work will be proven: which layers get unit tests, what must be
verified LIVE in the running app.
```

Complete when: the Approach is concrete enough to predict the shape of the
code (for a survey: it describes how the feature is actually built, with
file/module names); at least one rejected alternative — or an honest "not
inferable from the code" — is recorded; Affected components state what is
untouched, not only what changes.

### Evidence artifacts

One artifact per coherent body of evidence (typically one per feature; more
when distinct subsystems ground distinct claims):

- **Title** — what it evidences and where, e.g.
  `Survey evidence: markdown export (packages/cli/src/export.ts)`.
- **Body** — the repo-relative file paths, short verbatim excerpts (a few
  lines each), and your rationale connecting excerpt to claim. Excerpts, not
  file dumps: the artifact must stay well under the 20,000-character cap and
  be readable by the human reviewer in one sitting.

## Failure paths

**401 / unauthorized** — bearer token missing or wrong. Fix the MCP
registration (`Authorization: Bearer <token>`); don't retry blindly.

**Connection refused** — the server is down. Ask the human to start it,
bound to the survey project:
`KILN_MCP_TOKEN=<secret> KILN_PROJECT=<slug> pnpm -C packages/mcp-server start`
(in the Kiln repo).

**`Proposal rejected — nothing was created: …`** — validation failed; the
message lists every failing document and check. Fix exactly what is named and
retry (step 6). Never weaken evidence to pass.

**`No product root: …`** — the store has no parentless requirement, meaning
the project was not created through the app or `kiln projects create` (both
seed the root). Ask the human to create the project properly (or create the
root requirement themselves); do not work around it by inventing parents.

**`Ambiguous product root: N parentless requirements (…)`** — the store has
several parentless requirements. In a survey target this means the project is
**not fresh** (or is malformed) — treat it as the populated-project case:
warn, show the human the listed titles, and stop. Do not pick one yourself.

**`Parent requirement not found` / `is a <type>, not a requirement`** — you
passed a bad `parentRequirementId`. Use the `requirementId` returned by the
parent's own `propose_feature` call, nothing else.

**`Root overview refused: … non-empty body` / `… edited since seeding` /
`… pending suggestion(s)`** — the root pair is not pristine. The first two
are populated-project signals: treat them as the case below. A pending
suggestion means a proposal (possibly your own earlier call) awaits review —
the human resolves it in the app; never work around the lock.

**Populated project discovered mid-survey** — any signal that the target
holds real documents beyond the seeded root (ready work orders, an ambiguous
root, a non-pristine root pair, the human mentioning existing content): stop
proposing immediately, report what you already proposed, and let the human
decide. v1 does not merge into populated graphs.

## Non-negotiables

1. **Never propose without evidence.** Every feature carries at least one
   evidence artifact with real file paths and excerpts. If you cannot cite
   code, it is not in the tree.
2. **Never accept your own proposals.** The human gates every document in the
   Kiln app. You propose, report, and stop — no acceptance, no work orders
   under unaccepted features.
3. **Warn and stop if the target project is already populated.** Fresh
   projects only; the seeded root + architecture blueprint is the only
   pre-existing content you may see.
4. **Confirm the server's project binding before the first proposal.** A
   survey pointed at the wrong store pollutes it with dozens of entities.
5. **Fix rejections; never weaken them away.** No deleted evidence, no filler
   sections, no cap-ducking splits.
6. **Evidence is quoted, never fabricated.** Excerpts are verbatim from files
   you actually read, with their real paths.
