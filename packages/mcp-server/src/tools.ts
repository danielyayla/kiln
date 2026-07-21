import { z, ZodError } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  allowedNextStatuses,
  assembleWorkOrderContext,
  canTransition,
  readyGateBlockers,
  DEFAULT_STATUS,
  NotFoundError,
  readyWorkOrders,
  recordCompletionReceipt,
  recordContextReceipt,
  WORK_ORDER_STATUSES,
  workOrderDependencies,
  type CompletionReceipt,
  type Store,
  type WorkOrderStatus,
} from "@kiln/core";
import {
  completionReportSchema,
  entitySchema,
  readyWorkOrderSummarySchema,
  workOrderContextShape,
} from "./entity-schema.js";

const SUMMARY_LENGTH = 200;

function summarize(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= SUMMARY_LENGTH ? trimmed : `${trimmed.slice(0, SUMMARY_LENGTH)}…`;
}

// A tool-level error: reported to the client as a failed tool call (never thrown),
// so the agent sees a clear message instead of a transport-level fault.
function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// A successful result carrying both human-readable text and validated structured
// content (the latter matched against the tool's output schema by the SDK).
function ok(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

// Registers the three FRD-3 tools against a shared Store. Pure over the store:
// no HTTP or auth concerns leak in here, which keeps this unit-testable via an
// in-memory transport.
export function registerTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_ready_work_orders",
    {
      title: "List ready work orders",
      description:
        "List every work order that is 'ready' AND unblocked — its status is ready and every depends_on target is done (id, title, and a short summary of its body).",
      inputSchema: {},
      outputSchema: { workOrders: z.array(readyWorkOrderSummarySchema) },
    },
    async () => {
      const workOrders = readyWorkOrders(store).map((w) => ({
        id: w.id,
        title: w.title,
        summary: summarize(w.body),
      }));
      return ok({ workOrders });
    },
  );

  server.registerTool(
    "get_work_order",
    {
      title: "Get work order context",
      description:
        "Return the full linked context for a work order: its blueprint, that blueprint's requirement, the requirement's referenced artifacts, and the work order's depends_on dependencies (id, title, status).",
      inputSchema: { id: z.string().min(1) },
      outputSchema: workOrderContextShape,
    },
    async ({ id }) => {
      let context;
      try {
        context = assembleWorkOrderContext(store, id);
      } catch (err) {
        if (err instanceof NotFoundError) return toolError(`Work order not found: ${id}`);
        throw err;
      }
      if (context.workOrder.type !== "work_order") {
        return toolError(`Entity ${id} is a ${context.workOrder.type}, not a work order`);
      }
      // Record the handoff (Phase 8 provenance). This read intentionally writes
      // an audit record; dedupe keeps identical re-fetches quiet. The returned
      // payload is unchanged.
      recordContextReceipt(store, id);
      const dependencies = workOrderDependencies(store, id);
      return ok({ ...context, dependencies });
    },
  );

  server.registerTool(
    "update_work_order_status",
    {
      title: "Update work order status",
      description:
        "Transition a work order's status. Allowed: draft→ready, ready→in_progress, in_progress→done, and any state→cancelled. " +
        "Closing in_progress→done REQUIRES a completion report — summary (what was built) and verification (how it was proven, with real output), " +
        "plus optional commits/branch/filesTouched testimony — and records an immutable completion receipt with the transition, returning its id. " +
        "A report on any other transition is rejected.",
      inputSchema: {
        id: z.string().min(1),
        status: z.enum(WORK_ORDER_STATUSES),
        report: completionReportSchema.optional(),
      },
      outputSchema: {
        workOrder: entitySchema,
        completionReceiptId: z.string().optional(),
      },
    },
    async ({ id, status, report }) => {
      const entity = store.getEntity(id);
      if (!entity) return toolError(`Work order not found: ${id}`);
      if (entity.type !== "work_order") {
        return toolError(`Entity ${id} is a ${entity.type}, not a work order`);
      }
      const from: WorkOrderStatus = entity.status ?? DEFAULT_STATUS;
      if (!canTransition(from, status)) {
        const allowed = allowedNextStatuses(from);
        return toolError(
          `Invalid status transition ${from} → ${status}. ` +
            `Allowed from ${from}: ${allowed.length ? allowed.join(", ") : "(none — terminal)"}.`,
        );
      }
      // A completion report travels only on the closing transition — anywhere
      // else it is a caller mistake, refused loudly over silently dropped.
      const closing = from === "in_progress" && status === "done";
      if (report && !closing) {
        return toolError(
          `A completion report is only accepted when closing in_progress → done; this is ${from} → ${status}. ` +
            `No receipt was recorded and the status is unchanged.`,
        );
      }
      // Completeness gate (methodology layer 3): agents cannot set an
      // incomplete work order ready — and there is deliberately no override
      // over MCP; a human fixes the document or overrides in the app.
      if (from === "draft" && status === "ready") {
        const blockers = readyGateBlockers(store, id);
        if (blockers.length > 0) {
          return toolError(
            `Not ready — completeness gate: ${blockers.map((b) => b.code).join(", ")}. ` +
              `A human must fix the document (or override in the Kiln app).`,
          );
        }
      }
      if (closing) {
        if (!report) {
          return toolError(
            "Closing in_progress → done requires a completion report. Missing: report.summary (what was built) " +
              "and report.verification (how it was proven, with real output). Optional testimony: report.commits, " +
              "report.branch, report.filesTouched. The status is unchanged.",
          );
        }
        // Receipt before status write: a failed receipt write leaves the
        // transition untaken, so a receipt-less `done` cannot exist.
        let receipt: CompletionReceipt;
        try {
          receipt = recordCompletionReceipt(store, id, report);
        } catch (err) {
          if (err instanceof ZodError) {
            const issues = err.issues
              .map((i) => `${["report", ...i.path].join(".")}: ${i.message}`)
              .join("; ");
            return toolError(`Invalid completion report — no receipt recorded, status unchanged: ${issues}`);
          }
          const message = err instanceof Error ? err.message : String(err);
          return toolError(`Completion receipt could not be recorded — status unchanged: ${message}`);
        }
        const updated = store.updateEntity(id, { status });
        return ok({ workOrder: updated, completionReceiptId: receipt.id });
      }
      const updated = store.updateEntity(id, { status });
      return ok({ workOrder: updated });
    },
  );
}
