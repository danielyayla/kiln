import { randomUUID } from "node:crypto";
import {
  effectiveCriticality,
  VerificationVerdict,
  type Criticality,
  type Id,
  type VerificationReceipt,
} from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import type { Store } from "../store";

// Record a verification verdict against a work order — the judgment half of
// the receipt loop (a completion receipt records the agent's testimony; a
// verification receipt records an independent per-criterion judgment of that
// testimony against the acceptance criteria). Validates the verdict, confirms
// the target is an existing work order, persists, returns the receipt.
//
// Deliberately does NOT check the work order's STATUS: when verification may
// run is policy, and policy lives at the caller's boundary (the sidecar/CLI
// trigger it on done orders). Append-only: re-verifying yields a second
// receipt, never an overwrite.
export function recordVerificationReceipt(
  store: Store,
  workOrderId: Id,
  verdict: VerificationVerdict,
): VerificationReceipt {
  const data = VerificationVerdict.parse(verdict);
  const target = store.getEntity(workOrderId);
  if (!target) throw new NotFoundError(workOrderId);
  if (target.type !== "work_order") {
    throw new ConstraintError(
      `verification receipts attach to work orders; ${workOrderId} is a ${target.type}`,
    );
  }
  const receipt: VerificationReceipt = {
    id: randomUUID(),
    workOrderId,
    ...data,
    createdAt: new Date().toISOString(),
  };
  store.saveVerificationReceipt(receipt);
  return receipt;
}

// Verification status, derived — never stored (a verdict is a receipt, not a
// status; the BP-3 lifecycle stays closed). Classified from the LATEST
// verification receipt: re-verification supersedes earlier verdicts for
// display, while the full receipt history stays readable underneath.
export const VERIFICATION_STATUSES = ["unverified", "verified", "verified_with_failures"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// `verified` requires a clean latest verdict: overall met AND every criterion
// met. Anything short of that — an unmet or undecidable criterion, or a
// non-met overall — is verified_with_failures: a verification happened and it
// found something to look at. Pure over the Store; status-agnostic (callers
// scope the signal to done work orders).
export function verificationStatus(store: Store, workOrderId: Id): VerificationStatus {
  const receipts = store.listVerificationReceipts(workOrderId);
  if (receipts.length === 0) return "unverified";
  const latest = receipts[receipts.length - 1];
  const clean = latest.overall === "met" && latest.criteria.every((c) => c.status === "met");
  return clean ? "verified" : "verified_with_failures";
}

// The Pulse-consumable attention list: done work orders whose latest verdict
// is not a clean pass, weighted by criticality. Routine orders are excluded —
// routine unverified is quiet by design in v1 (chips before gates); critical
// ones are the needs-attention signal, so they sort first.
export interface VerificationAttentionEntry {
  id: Id;
  title: string;
  // Effective criticality — never routine here.
  criticality: Criticality;
  verification: Exclude<VerificationStatus, "verified">;
}

const CRITICALITY_RANK: Record<Criticality, number> = { critical: 0, important: 1, routine: 2 };

export function verificationAttention(store: Store): VerificationAttentionEntry[] {
  return store
    .workOrdersByStatus("done")
    .filter((wo) => effectiveCriticality(wo) !== "routine")
    .map((wo) => ({ wo, verification: verificationStatus(store, wo.id) }))
    .filter(({ verification }) => verification !== "verified")
    .map(({ wo, verification }) => ({
      id: wo.id,
      title: wo.title,
      criticality: effectiveCriticality(wo),
      verification: verification as Exclude<VerificationStatus, "verified">,
    }))
    .sort(
      (a, b) =>
        CRITICALITY_RANK[a.criticality] - CRITICALITY_RANK[b.criticality] ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}
