import { randomUUID } from "node:crypto";
import { VerificationVerdict, type Id, type VerificationReceipt } from "../domain";
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
