# Forge — first-principles migration exercise (2026-07-27)

A design exercise: Kiln's knowledge graph migrated into "Forge", a hypothetical
refounding of the product on five primitives — **Intent, Decision, Task,
Source, Receipt** — instead of the four document genres. Produced during a
design-brief analysis session; nothing here is wired into the product.

## Contents

- `forge.db` — the migrated store (SQLite, WAL-checkpointed, self-contained).
  **Not committed** (gitignored, ~5 MB binary): regenerate it by running the
  pipeline below against a fresh snapshot of `~/.kiln/kiln.db`.
  Schema: `units` (kind ∈ intent|decision|task|source|receipt, with
  `ratified`/`provisional_reason` for the trust gradient and JSON `meta`),
  `edges` (rels: part_of, governs, governed_by, fulfills, cites, depends_on,
  records, version_of), `aliases` (every original Kiln entity id → Forge id).
- `scripts/` — the re-runnable pipeline, in execution order:
  1. `dryrun.mjs <kiln.db> <report.md>` — read-only per-entity disposition report.
  2. `mechanical-pass.mjs <snapshot.db> <forge.db> <report.json>` — deterministic
     migration (intents, tasks, sources, receipts, verbatim decision extraction).
  3. `export-pending.mjs <forge.db> <dir>` — batch distill-pending sources for
     distiller agents (agents write `out-N.json`: title/statement/category/
     rejected/excerpt per decision).
  4. `load-distilled.mjs <forge.db> <report.json> <out-*.json…>` — load distilled
     decisions as provisional; excerpts machine-verified against source bodies.
  5. `ratify-queue.mjs <forge.db> <queue.md>` — screen (dedup vs ratified and
     within-batch, evidence quality) and render the ratification queue.
  6. `ratify-clean.mjs <forge.db>` — ratify screen-clean decisions, hold flagged.
     (`ratify-apply.mjs` — ratify-all-except-skip-list variant.)
- `reports/` — the artifacts of the run against the live store:
  dry-run mapping, mechanical-pass integrity results (all checks zero
  violations; 93/93 receipt replay), distillation load report (176 loaded,
  0 evidence rejections), and the full screened ratification queue.

## Final state of `forge.db`

28 intents · 299 decisions (all ratified) · 156 tasks (149 governed,
7 degraded-archived) · 99 sources · 137 receipts · 243 aliases. Zero
unratified units, zero ungoverned tasks, zero dangling edges.

Scripts need `node --experimental-sqlite` on Node 22.x (stable on 24+).
The source snapshot was taken with `VACUUM INTO` from `~/.kiln/kiln.db`;
re-running against a fresh snapshot reproduces the pipeline end to end
(distillation output varies with the model; everything else is deterministic).
