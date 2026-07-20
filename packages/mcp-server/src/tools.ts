import { z } from "zod";
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
  recordContextReceipt,
  WORK_ORDER_STATUSES,
  workOrderDependencies,
  type Store,
  type WorkOrderStatus,
} from "@kiln/core";
import {
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
        "Transition a work order's status. Allowed: draft→ready, ready→in_progress, in_progress→done, and any state→cancelled.",
      inputSchema: {
        id: z.string().min(1),
        status: z.enum(WORK_ORDER_STATUSES),
      },
      outputSchema: { workOrder: entitySchema },
    },
    async ({ id, status }) => {
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
      const updated = store.updateEntity(id, { status });
      return ok({ workOrder: updated });
    },
  );
}
