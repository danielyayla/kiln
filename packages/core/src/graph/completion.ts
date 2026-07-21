import { randomUUID } from "node:crypto";
import { CompletionReport, type CompletionReceipt, type Id } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import type { Store } from "../store";

// Record an agent's completion report against a work order — the return half
// of the handoff loop (a context receipt records what was delivered; a
// completion receipt records what came back). Validates the report, confirms
// the target is an existing work order, persists, returns the receipt.
//
// Deliberately does NOT check the work order's STATUS: when a report is
// required is policy, and policy lives at the MCP boundary (blueprint section
// "Completion receipts — closing the handoff loop"). Append-only: recording
// twice yields two receipts, never an overwrite.
export function recordCompletionReceipt(
  store: Store,
  workOrderId: Id,
  report: CompletionReport,
): CompletionReceipt {
  const data = CompletionReport.parse(report);
  const target = store.getEntity(workOrderId);
  if (!target) throw new NotFoundError(workOrderId);
  if (target.type !== "work_order") {
    throw new ConstraintError(
      `completion receipts attach to work orders; ${workOrderId} is a ${target.type}`,
    );
  }
  const receipt: CompletionReceipt = {
    id: randomUUID(),
    workOrderId,
    ...data,
    createdAt: new Date().toISOString(),
  };
  store.saveCompletionReceipt(receipt);
  return receipt;
}
