import type { Entity, WorkOrderStatus } from "../domain";
import type { Store } from "../store";
import { DEFAULT_STATUS } from "../transitions";
import type { HealthCheck } from "./health";

// Drift checks (layer 2, reports-never-blocks): deterministic conditions
// computed from records the store already keeps — revisions, completion
// receipts, links, statuses. Revisions and receipts are the clocks: a document
// "moved" when a revision landed strictly after the latest relevant completion
// receipt. ISO-8601 strings compare lexically (as in pulse), and same-instant
// timestamps are NOT drift — the receipt written atomically with a close must
// never flag its own work order.

const effectiveStatus = (wo: Entity): WorkOrderStatus => wo.status ?? DEFAULT_STATUS;
const isOpen = (s: WorkOrderStatus) => s === "draft" || s === "ready" || s === "in_progress";

const latestReceiptAt = (store: Store, workOrderId: string): string | null => {
  // listCompletionReceipts is chronological (oldest first).
  const receipts = store.listCompletionReceipts(workOrderId);
  return receipts.length > 0 ? receipts[receipts.length - 1].createdAt : null;
};

export function driftChecks(store: Store, entity: Entity): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const add = (level: HealthCheck["level"], code: string, message: string) => checks.push({ level, code, message });

  if (entity.type === "work_order" && effectiveStatus(entity) === "done") {
    const receiptAt = latestReceiptAt(store, entity.id);
    if (receiptAt === null) {
      // Human closes (app/CLI) are legitimately report-free — info, not warn:
      // the chip only marks that no execution record exists to drift against.
      add(
        "info",
        "done-without-receipt",
        "Done with no completion receipt — no execution record exists to drift against.",
      );
    } else if (store.listRevisions(entity.id).some((r) => r.createdAt > receiptAt)) {
      add(
        "warn",
        "revised-after-done",
        "The body was revised after the completion receipt — the shipped work no longer matches this document.",
      );
    }
  }

  if (entity.type === "blueprint") {
    const implementing = store.linkedFrom(entity.id, "implements").filter((e) => e.type === "work_order");
    // An amended blueprint with an open implementing work order is
    // mid-reconciliation — no chip. No implementing work orders → no clock.
    if (implementing.length > 0 && !implementing.some((wo) => isOpen(effectiveStatus(wo)))) {
      const shippedAt = implementing
        .map((wo) => latestReceiptAt(store, wo.id))
        .filter((at): at is string => at !== null)
        .sort()
        .pop();
      if (shippedAt && store.listRevisions(entity.id).some((r) => r.createdAt > shippedAt)) {
        add(
          "warn",
          "amended-after-ship",
          "Amended after its implementing work orders shipped, with nothing open to reconcile it — cut a work order for the change or revert it.",
        );
      }
    }
  }

  return checks;
}
