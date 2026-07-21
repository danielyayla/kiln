import type { WorkType } from "../domain";

// Per-type execution guidance (BP-18): how an agent should work an order of
// this type, injected into every assembled context. A pure map — deterministic,
// model-free, versioned with the code — so the same work order always assembles
// byte-identical guidance.
const GUIDANCE: Record<WorkType, string> = {
  feature:
    "Feature work: implement to the blueprint's design and stop at the work-order boundary — adjacent improvements belong to other work orders.",
  bug: "Bug work: reproduce the failure first and keep the reproduction as a regression test; fix the root cause, not the symptom, and verify the original scenario passes.",
  refactor:
    "Refactor work: behavior must not change — no new features, no fixes folded in. Existing tests prove equivalence; strengthen them first where coverage is thin.",
  perf: "Performance work: measure before and after on the same scenario and cite both numbers in the completion report; no optimization lands without evidence it helped.",
  chore:
    "Chore work: make the smallest change that completes the task — no drive-by refactors, no scope creep; leave everything else exactly as found.",
};

export function workTypeGuidance(type: WorkType): string {
  return GUIDANCE[type];
}
