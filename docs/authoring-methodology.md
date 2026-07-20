# Kiln authoring methodology (DRAFT for review)

Status: draft v1 — IN THE STORE as an artifact under the feature requirement
"Opinionated authoring standards" (child_of the Kiln product root), so
context-assembly lineage delivers it to nested work orders — and, since it is
also `references`-linked from the product root, to EVERY document's context as
tier-3 background. All three enforcement layers are implemented: layer 1
(draft templates, the extraction prompt's work-order shape, and the
refine/review House-authoring-standards instruction), layer 2
(`documentHealth` chips), layer 3 (the draft→ready gate `readyGateBlockers` —
override via the app's confirm or CLI `--force`; never over MCP).

This document defines how the three authored artifact types — **feature
requirement**, **blueprint**, **work order** — are structured, what makes each
one *complete*, and the traceability rules that bind them. Agents follow it
when generating; deterministic health checks report against it; the
`draft → ready` transition (eventually) gates on it.

Principles:

1. **Born compliant.** The standard shapes generation; enforcement is a
   backstop, not the mechanism.
2. **Drafts are allowed to be messy.** Completeness is checked at status
   boundaries, never on save.
3. **Nothing is silently rewritten.** Methodology fixes arrive as suggestions
   through the existing pipeline; the human accepts or dismisses.
4. **Written for two readers.** Every artifact must work both for a human
   skimming the navigator and for a coding agent receiving it inside an
   assembled context with zero conversation history.

---

## 1. Feature requirement

A requirement states a **capability the user gains**, not a batch of work.
(Routing rule: if it doesn't give the user a new capability, it's a work
order under an existing feature — never a new requirement.)

**The document model has two levels.** The product root requirement is the
PRD-equivalent — the product overview and its non-goals, with the system
architecture as its `details` blueprint; there is exactly one. Every feature
requirement is a **feature-scoped requirement document (FRD)**: a PRD narrowed
to one capability. An FRD never restates the product context, because context
assembly delivers it — lineage hands every nested document the root overview
and architecture automatically (tier 3).

**Title convention (a rule, not a habit):**
`<Name> — <plain-language description of what it does>` — the feature's name,
an em-dash, then a user-facing description. Examples from the live graph:
"X-ray — intent-to-execution map", "Pulse — project health dashboard". A
reader skimming the navigator should learn what the feature does from the
title alone.

### Structure

```
# <Name — plain-language description of what it does>

## Capability
One paragraph: what the user can do after this exists that they cannot do
today. Written in terms of the user, not the system.

## Why
The motivating problem or opportunity. Link evidence where it exists
(artifact, competitive reference, dogfooding pain).

## Scope
Bulleted: what is IN. Each bullet is observable behavior, not implementation.

## Non-goals
Bulleted: what is explicitly OUT, especially things a reader would otherwise
assume are in. "None" is not acceptable — every feature has a tempting
adjacent scope it is declining.

## Success criteria
How we will know the capability works — observable, ideally demoable.
```

### Complete when
- [ ] Title follows `<Name> — <plain-language description>` (name, em-dash,
      user-facing description).
- [ ] Capability paragraph exists and names the *user's* new ability.
- [ ] At least one non-goal is stated.
- [ ] Success criteria are observable (a reader could verify without asking).
- [ ] `child_of` the product root (or a parent feature for sub-requirements).
- [ ] Motivation is grounded: a `references` artifact, or the Why section
      explains from first principles.

---

## 2. Blueprint

A blueprint records **how and why**, for exactly one requirement. It is the
document a coding agent reads to make the dozens of small decisions the work
order doesn't spell out. Optimize for decisions, not prose.

### Structure

```
# BP-<n> — <Approach name>

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
State the additive-vs-breaking character (schema? Store interface? links?
transitions?).

## Conventions & constraints
Rules the implementation must follow that the code can't express: token-only
styling, pure-function layout, Store-interface-only data access, etc. Inherit
from the architecture blueprint by reference; state only deltas and
reinforcements.

## Verification strategy
How the work will be proven: which layers get unit tests, what must be
verified LIVE in the running app, what "dogfooded" means for this feature.
```

### Complete when
- [ ] Linked `details` to exactly one requirement.
- [ ] Approach section exists and is concrete enough to predict the diff.
- [ ] At least one rejected alternative is recorded.
- [ ] Affected components state what is untouched, not only what changes.
- [ ] Verification strategy names the live-verification step (tests alone
      don't count for UI-touching work).

Amendments to an existing feature's blueprint go through suggestions
(refine/review agents) with revision history — never a parallel second
blueprint for the same requirement.

---

## 3. Work order

A work order is **one reviewable increment** handed to an agent with no
conversation context. The assembled context (WO + blueprint + requirement +
lineage) must be sufficient on its own; if the WO only makes sense with tribal
knowledge, the WO is incomplete.

### Structure

```
# [work-type] <Imperative title — what will be true when done>

## Scope
2–4 sentences: exactly what this WO delivers and where it stops. Name the
files/modules if known.

## Out of scope
What an eager agent might do but must not (adjacent refactors, the next WO's
territory).

## Acceptance criteria
Bulleted, each independently checkable:
- [ ] behavior X observable at layer Y
- [ ] tests: <what new tests prove>
- [ ] live verification: <what is confirmed in the running app>, when UI-facing

## Implementation hints (optional but strongly encouraged)
- **Files likely to change** — best-guess list; hints, not a contract.
- **Files that must NOT change** — the durable half; pairs with the
  blueprint's "explicitly untouched" statement.
- **Reuse** — existing components, query keys, helpers, styles the
  implementation should build on instead of re-creating.

## Notes (optional)
Gotchas, pointers into the blueprint, known landmines.
```

Work-type prefixes: `[bug]` `[refactor]` `[perf]` `[chore]`; capability work
carries no prefix. Title batching labels ("Phase N") go in the title only,
never as requirements.

### Complete when
- [ ] `implements` link to the blueprint that details its requirement (never
      straight to the requirement — see traceability rule 1).
- [ ] Scope AND out-of-scope both present.
- [ ] Every acceptance criterion is verifiable without asking the author.
- [ ] `depends_on` edges exist for every real ordering constraint — and for
      no imaginary ones (false edges block the readiness filter).
- [ ] Sized as one increment: one agent session, one review. If the
      acceptance list reads like a table of contents, split it.
- [ ] Context health shows no `danger` findings (the existing
      `contextHealth` checks become part of this gate for free).

---

## 4. Traceability rules (cross-cutting)

These bind the graph together; most are already enforced or surfaced by
`graphGaps` / readiness — this section makes them the stated standard.

1. Every work order `implements` exactly one **blueprint**. Context assembly
   resolves WO →implements→ blueprint →details→ requirement; a work order
   linked straight to a requirement assembles a DEGRADED context (requirement
   slot empty, no lineage, no root intent) — verified live 2026-07-11.
2. Every blueprint `details` exactly one requirement. (A requirement may
   accumulate multiple blueprints over its life; the current-approach one
   should be discoverable — nested historical BPs stay as history.)
3. Every requirement except the product root is `child_of` a requirement.
4. Evidence flows via `references` artifacts; claims in Why/Approach sections
   should trace to one where evidence exists.
5. `depends_on` is only ever WO → WO and only for true ordering constraints.
6. Vocabulary is inherited downward: a WO uses the terms its blueprint
   defines; a blueprint uses the terms its requirement defines. New terms are
   introduced at the highest level that needs them.

---

## 5. Context tiers (how assembled context is prioritized)

Assembled work-order context is consumed in priority order. Producers keep
everything; consumers are told what is actionable and what is background.

- **Tier 1 — actionable (read first, follow exactly):** the work order, its
  blueprint, its requirement, dependencies, constraints/acceptance criteria.
- **Tier 2 — situational (consult when relevant):** direct artifacts,
  ancestor requirements/blueprints in the lineage (nearest first),
  project conventions.
- **Tier 3 — background (skim, never study):** the product root overview and
  architecture blueprint — the OUTERMOST lineage entry. It explains intent;
  it never overrides tier 1.

Rules: lineage stays nearest-ancestor-first (tier 3 last); any linear
rendering of context (Copy context, prompts) emits tiers in order with a
visible divider before background; nothing is trimmed — length problems are
handled by health checks (oversized, low-signal, tier-share), not deletion.

## 6. Enforcement ladder (how strictly each rule bites)

| Layer | Mechanism | When | Blocking? |
|---|---|---|---|
| Generate | Methodology injected into agent prompts via lineage | drafting / extraction / refine / review | no |
| Check | `documentHealth(entity)` deterministic structural checks | always visible (chips in inspector / pulse) | no |
| Gate | `draft → ready` transition validates the "Complete when" list | on transition only | yes, with explicit override |

The gate applies only to work orders initially (they feed agents directly).
Requirements and blueprints get chips only until the checklists have been
dogfooded for at least one feature cycle.

## 7. Authoring skills (user-defined standards)

This methodology is the DEFAULT house style, not a cage. **Authoring skills**
let a user or organization state their own standards — structure, section
order, tone, naming conventions, terminology, required sections — and have
every authoring agent follow them automatically.

The convention (revised 2026-07-13 — skills moved from artifact entities into
settings; configuration and knowledge have different audiences, and skills are
configuration):

- **A skill is a settings document, not an entity.** The
  `kiln.authoring.skills` setting holds an ordered JSON array of
  `{ id, title, body, enabled }` documents. Skills never appear in the
  knowledge graph, the navigator, Quick Open, or export.
- **Settings → Blueprint Writing is a skill's entire world.** Create, view,
  edit, rename, enable/disable, reorder, and delete all happen there and only
  there. Array order = injection order; `enabled` is the switch (disabled
  skills stay listed instead of being forgotten). Trade-off, accepted
  deliberately: skill edits carry NO revision history and cannot be refined or
  reviewed by agents — the settings value is the single current version.
- **Injection is at system-prompt strength, not context tier 3.** Enabled
  skills render as a dedicated "Authoring skills (house standards — follow
  these)" section ahead of the assembled context in every draft, extraction,
  refine-chat, and review call. Unlike the methodology artifact riding along
  as tier-3 background, skills are actionable instructions the agent must
  follow.
- **Per-type template override.** A skill may replace a built-in draft
  template (`methodology-requirement`, `methodology-blueprint`, or the
  extraction work-order shape) verbatim by declaring a section headed
  `## Template: requirement`, `## Template: blueprint`, or
  `## Template: work-order`. Write the template inside a code fence — template
  bodies legitimately contain `##` headings, so the fence is what delimits
  them (unfenced, the section runs to the next `## Template:` heading or the
  end of the body). When several enabled skills declare the same type, the
  first in order wins, deterministically.
- **Zero enabled skills = this document applies.** With nothing enabled,
  every agent output path is byte-identical to the built-in behavior: the
  hardcoded house-standards instruction and the `methodology-*` templates in
  `packages/agents` are the fallback. Skills override the default; they never
  erode it.

Resolution lives once in core (`resolveAuthoringSkills(store)`) and is
consumed identically by the desktop sidecar and the CLI, so `kiln draft`,
`kiln extract`, and `kiln review` honor the same enabled set as the app.
