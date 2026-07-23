import { z, ZodError } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  allowedNextStatuses,
  assembleWorkOrderContext,
  canTransition,
  ConstraintError,
  DESIGN_DOC_TEMPLATE,
  readyGateBlockers,
  DEFAULT_STATUS,
  NotFoundError,
  proposeFeature,
  proposeRootOverview,
  readyWorkOrders,
  recordCompletionReceipt,
  recordContextReceipt,
  rootRequirements,
  WORK_ORDER_STATUSES,
  workOrderDependencies,
  type CompletionReceipt,
  type Entity,
  type Store,
  type WorkOrderStatus,
} from "@kiln/core";
import {
  completionReportSchema,
  entitySchema,
  proposedDocumentSchema,
  readyWorkOrderSummarySchema,
  workOrderContextShape,
  proposalResultShape,
  rootProposalResultShape,
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

// Size caps for propose_feature, enforced with named rejections and documented
// in the tool description so agents see them before tripping them.
const PROPOSAL_TITLE_CAP = 200;
const PROPOSAL_BODY_CAP = 20_000;
const PROPOSAL_EVIDENCE_CAP = 20;

// Same canonical-heading test documentHealth uses (docs/authoring-methodology.md).
const hasHeading = (body: string, title: string) =>
  new RegExp(`^#{1,6}\\s*${title}\\b`, "im").test(body);

interface ProposedDocument {
  title: string;
  body: string;
}

// Boundary validation for a proposed feature: caps and blank fields for every
// document, plus the body-derivable selection of the blocking document-health
// rules (the ready-gate pattern: a selection over documentHealth, not new
// rules). Proposals must be born compliant — an ill-formed document is
// rejected here, never pushed onto the human reviewer. Returns failure
// messages naming the offending document; empty = pass.
function proposalFailures(
  requirement: ProposedDocument,
  blueprint: ProposedDocument,
  evidence: ProposedDocument[],
  parentIsProductRoot: boolean,
): string[] {
  const failures: string[] = [];
  const documents: Array<[string, ProposedDocument]> = [
    ["requirement", requirement],
    ["blueprint", blueprint],
    ...evidence.map((e, i): [string, ProposedDocument] => [`evidence[${i}]`, e]),
  ];
  for (const [name, doc] of documents) {
    if (doc.title.trim() === "") failures.push(`${name}: title is empty or whitespace-only`);
    else if (doc.title.length > PROPOSAL_TITLE_CAP)
      failures.push(`${name}: title exceeds ${PROPOSAL_TITLE_CAP} characters (${doc.title.length})`);
    if (doc.body.trim() === "")
      failures.push(`${name}: body is empty or whitespace-only (empty-body)`);
    else if (doc.body.length > PROPOSAL_BODY_CAP)
      failures.push(`${name}: body exceeds ${PROPOSAL_BODY_CAP} characters (${doc.body.length})`);
  }
  if (evidence.length === 0) {
    failures.push("evidence: at least one evidence artifact is required — a proposal without evidence is an invention");
  } else if (evidence.length > PROPOSAL_EVIDENCE_CAP) {
    failures.push(`evidence: ${evidence.length} artifacts exceed the cap of ${PROPOSAL_EVIDENCE_CAP}`);
  }
  if (requirement.body.trim() !== "" && !hasHeading(requirement.body, "Non-goals")) {
    failures.push(
      "requirement: no Non-goals section (missing-non-goals) — every feature has adjacent scope it should decline",
    );
  }
  if (parentIsProductRoot && !/^.+ — (.*\S.*)$/u.test(requirement.title)) {
    failures.push(
      "requirement: feature title must follow `<Name> — <plain-language description>` (feature-title-shape)",
    );
  }
  return failures;
}

// Boundary validation for the surveyed root documents: the same caps and
// born-compliant discipline as proposalFailures, over two body-only documents
// (the seeded root pair keeps its titles) plus optional evidence.
function rootProposalFailures(
  overview: string,
  architecture: string,
  evidence: ProposedDocument[],
): string[] {
  const failures: string[] = [];
  const bodies: Array<[string, string]> = [
    ["overview", overview],
    ["architecture", architecture],
  ];
  for (const [name, body] of bodies) {
    if (body.trim() === "") failures.push(`${name}: body is empty or whitespace-only (empty-body)`);
    else if (body.length > PROPOSAL_BODY_CAP)
      failures.push(`${name}: body exceeds ${PROPOSAL_BODY_CAP} characters (${body.length})`);
  }
  for (const [i, doc] of evidence.entries()) {
    const name = `evidence[${i}]`;
    if (doc.title.trim() === "") failures.push(`${name}: title is empty or whitespace-only`);
    else if (doc.title.length > PROPOSAL_TITLE_CAP)
      failures.push(`${name}: title exceeds ${PROPOSAL_TITLE_CAP} characters (${doc.title.length})`);
    if (doc.body.trim() === "")
      failures.push(`${name}: body is empty or whitespace-only (empty-body)`);
    else if (doc.body.length > PROPOSAL_BODY_CAP)
      failures.push(`${name}: body exceeds ${PROPOSAL_BODY_CAP} characters (${doc.body.length})`);
  }
  if (evidence.length > PROPOSAL_EVIDENCE_CAP) {
    failures.push(`evidence: ${evidence.length} artifacts exceed the cap of ${PROPOSAL_EVIDENCE_CAP}`);
  }
  if (overview.trim() !== "" && !hasHeading(overview, "Non-goals")) {
    failures.push(
      "overview: no Non-goals section (missing-non-goals) — the product overview states what the product deliberately does not do",
    );
  }
  return failures;
}

// Registers the MCP tools against a shared Store. Pure over the store:
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
        "Return the full linked context for a work order: its blueprint, that blueprint's requirement, the requirement's referenced artifacts, the work order's depends_on dependencies (id, title, status), plus its workType and per-type execution guidance — follow the guidance while implementing.",
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

  server.registerTool(
    "propose_feature",
    {
      title: "Propose a feature for human review",
      description:
        "Propose ONE feature (per call) as a GATED write: creates an empty-bodied requirement and blueprint " +
        "(linked child_of → parent and details → requirement) and files their proposed bodies as PENDING " +
        "suggestions a human accepts or rejects in the Kiln app — nothing is committed by this call. Evidence " +
        "artifacts are created with their bodies and references-linked from the requirement. This is the only " +
        "document-write path over MCP, and it is deliberately gated: there are no UNGATED document writes. " +
        "parentRequirementId is optional — when omitted, the single parentless product root is resolved " +
        "automatically (none or several is an error). Caps: titles ≤ 200 chars, bodies ≤ 20,000 chars, " +
        "1–20 evidence artifacts. Proposed documents must be born compliant: the requirement body needs a " +
        "Non-goals section, and a feature proposed under the product root needs a " +
        "'<Name> — <plain-language description>' title.",
      inputSchema: {
        requirement: proposedDocumentSchema,
        blueprint: proposedDocumentSchema,
        evidence: z.array(proposedDocumentSchema),
        parentRequirementId: z.string().min(1).optional(),
      },
      outputSchema: proposalResultShape,
    },
    async ({ requirement, blueprint, evidence, parentRequirementId }) => {
      // Resolve the parent before validating: the feature-title-shape rule
      // applies only to features landing directly under the product root.
      let parent: Entity;
      if (parentRequirementId) {
        const found = store.getEntity(parentRequirementId);
        if (!found) return toolError(`Parent requirement not found: ${parentRequirementId}`);
        if (found.type !== "requirement") {
          return toolError(`Proposal parent ${parentRequirementId} is a ${found.type}, not a requirement`);
        }
        parent = found;
      } else {
        const roots = rootRequirements(store);
        if (roots.length === 0) {
          return toolError(
            "No product root: the store has no parentless requirement to attach this feature to. " +
              "Pass parentRequirementId explicitly.",
          );
        }
        if (roots.length > 1) {
          return toolError(
            `Ambiguous product root: ${roots.length} parentless requirements ` +
              `(${roots.map((r) => `"${r.title}"`).join(", ")}). Pass parentRequirementId explicitly.`,
          );
        }
        parent = roots[0];
      }
      const parentIsProductRoot =
        store.linked(parent.id, "child_of").length === 0 && rootRequirements(store).length === 1;

      const failures = proposalFailures(requirement, blueprint, evidence, parentIsProductRoot);
      if (failures.length > 0) {
        return toolError(`Proposal rejected — nothing was created:\n- ${failures.join("\n- ")}`);
      }

      try {
        const ids = proposeFeature(store, parent.id, { requirement, blueprint, evidence });
        return ok({
          requirementId: ids.requirementId,
          blueprintId: ids.blueprintId,
          artifactIds: ids.artifactIds,
          suggestionIds: [ids.requirementSuggestionId, ids.blueprintSuggestionId],
        });
      } catch (err) {
        // Core re-validates authoritatively; its typed rejections (and the
        // compensated mid-write failure) surface as tool errors, not faults.
        if (err instanceof ConstraintError || err instanceof NotFoundError) {
          return toolError(`Proposal rejected — nothing was created: ${err.message}`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "propose_root_overview",
    {
      title: "Propose the surveyed product overview for human review",
      description:
        "Propose the survey's ROOT documents as a GATED write: the product overview lands as a PENDING " +
        "suggestion on the product root requirement, and the system-architecture summary as one on the " +
        "root's details blueprint — a human accepts or rejects each in the Kiln app; nothing is committed " +
        "by this call, and the seeded titles are untouched. Optional evidence artifacts (0–20) are created " +
        "with their bodies and references-linked from the root. The root pair must be PRISTINE: the call " +
        "refuses loudly when the root body is non-empty, when the architecture blueprint was edited since " +
        "seeding, or when either document already has a pending suggestion — v1 proposes only into a fresh " +
        "project (no merge semantics). Caps: bodies ≤ 20,000 chars, evidence titles ≤ 200 chars. The " +
        "overview must contain a Non-goals section.",
      inputSchema: {
        overview: z.string().min(1),
        architecture: z.string().min(1),
        evidence: z.array(proposedDocumentSchema).optional(),
      },
      outputSchema: rootProposalResultShape,
    },
    async ({ overview, architecture, evidence }) => {
      const evidenceList = evidence ?? [];
      // The root pair is THE target — no id input; resolution mirrors
      // propose_feature's omitted-parent path.
      const roots = rootRequirements(store);
      if (roots.length === 0) {
        return toolError(
          "No product root: the store has no parentless requirement to receive the overview. " +
            "Create the project via the app or `kiln projects create` (both seed the root pair).",
        );
      }
      if (roots.length > 1) {
        return toolError(
          `Ambiguous product root: ${roots.length} parentless requirements ` +
            `(${roots.map((r) => `"${r.title}"`).join(", ")}). This project is not fresh — stop the survey.`,
        );
      }
      const root = roots[0];
      const blueprints = store.linkedFrom(root.id, "details").filter((e) => e.type === "blueprint");
      if (blueprints.length === 0) {
        return toolError(
          `Product root "${root.title}" has no details blueprint to receive the architecture summary. ` +
            "Create the project via the app or `kiln projects create` (both seed it).",
        );
      }
      if (blueprints.length > 1) {
        return toolError(
          `Ambiguous architecture target: product root "${root.title}" has ${blueprints.length} details blueprints.`,
        );
      }
      const blueprint = blueprints[0];

      // Target-state refusals come first — they mean "stop the survey", not
      // "fix the document and retry".
      if (root.body.trim() !== "") {
        return toolError(
          `Root overview refused: requirement "${root.title}" already has a non-empty body. ` +
            "v1 proposes only into a pristine root — edit the existing overview in the Kiln app instead.",
        );
      }
      if (blueprint.body.trim() !== "" && blueprint.body !== DESIGN_DOC_TEMPLATE) {
        return toolError(
          `Root overview refused: architecture blueprint "${blueprint.title}" has been edited since seeding. ` +
            "v1 proposes only over the pristine template — amend it in the Kiln app instead.",
        );
      }
      for (const target of [root, blueprint]) {
        const pending = store.listSuggestions(target.id).length;
        if (pending > 0) {
          return toolError(
            `Root overview refused: ${target.type} "${target.title}" has ${pending} pending suggestion(s). ` +
              "A human must resolve or dismiss them in the Kiln app first.",
          );
        }
      }

      const failures = rootProposalFailures(overview, architecture, evidenceList);
      if (failures.length > 0) {
        return toolError(`Proposal rejected — nothing was created:\n- ${failures.join("\n- ")}`);
      }

      try {
        const ids = proposeRootOverview(store, root.id, {
          overview,
          architecture,
          evidence: evidenceList,
        });
        return ok({
          rootRequirementId: ids.rootRequirementId,
          blueprintId: ids.blueprintId,
          artifactIds: ids.artifactIds,
          suggestionIds: [ids.overviewSuggestionId, ids.architectureSuggestionId],
        });
      } catch (err) {
        if (err instanceof ConstraintError || err instanceof NotFoundError) {
          return toolError(`Proposal rejected — nothing was created: ${err.message}`);
        }
        throw err;
      }
    },
  );
}
