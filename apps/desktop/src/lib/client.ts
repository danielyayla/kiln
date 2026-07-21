// Typed client for the sidecar API. Type-only imports from @kiln/core keep
// node:sqlite out of the webview bundle — the browser never touches core at
// runtime, only its types.
import type {
  ActivityEvent,
  AuthoringSkillDoc,
  CompletionReceipt,
  ContextHealth,
  ContextReceipt,
  DocumentHealth,
  EditOp,
  Entity,
  EntityType,
  FeatureTreeNode,
  GraphSnapshot,
  KnowledgeHealth,
  LinkType,
  ProjectPulse,
  Revision,
  Suggestion,
  SuggestionSource,
  UsageReport,
  WorkOrderContext,
  WorkOrderStatus,
  WorkType,
} from "@kiln/core";
// Type-only — erased at build, so @kiln/agents (and the Anthropic SDK) never
// enter the webview bundle.
import type { Finding, WorkOrderCandidate } from "@kiln/agents";

const BASE = import.meta.env.VITE_KILN_SIDECAR_URL ?? "http://127.0.0.1:4823";

// One turn in a refine chat transcript. Session-local — never persisted.
export type ChatMessage = { role: "user" | "assistant"; content: string };

// Dependency readiness of one work order (WO-B2): blocked when any depends_on
// target is not yet done; `blocking` lists those targets.
export type WorkOrderReadiness = {
  id: string;
  blocked: boolean;
  blocking: { id: string; title: string; status: WorkOrderStatus | null }[];
};

// The masked AI-settings view (AI settings & usage): everything the webview
// may know about the key is `hasKey` + the last four characters.
export type AiSettings = {
  provider: "anthropic";
  enabled: boolean;
  hasKey: boolean;
  keyTail: string | null;
};

// A registry entry as the sidecar exposes it (Projects feature): the webview
// is path-blind, so dbPath never appears here.
export type PublicProject = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  lastOpenedAt: string | null;
};

export type ProjectList = {
  projects: PublicProject[];
  defaultProject: string | null;
  activeProject: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  health: () => request<{ ok: boolean; providerAvailable: boolean; aiEnabled: boolean }>("/health"),
  // Projects: the registry as the sidecar exposes it — never a file path.
  projects: () => request<ProjectList>("/projects"),
  createProject: (name: string) =>
    request<PublicProject>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  activateProject: (id: string) => request<ProjectList>(`/projects/${id}/activate`, { method: "POST" }),
  aiSettings: () => request<AiSettings>("/settings/ai"),
  // Partial update; `apiKey: null` removes the stored key. The raw key goes up
  // and never comes back — the response is the masked view.
  putAiSettings: (patch: { apiKey?: string | null; provider?: "anthropic"; enabled?: boolean }) =>
    request<AiSettings>("/settings/ai", { method: "PUT", body: JSON.stringify(patch) }),
  usage: () => request<UsageReport>("/usage"),
  // Authoring skills are settings documents — full {id, title, body, enabled}
  // docs travel both ways; array order = injection order. PUT echoes the
  // persisted (deduped) array.
  authoringSkills: () => request<AuthoringSkillDoc[]>("/settings/authoring-skills"),
  putAuthoringSkills: (docs: AuthoringSkillDoc[]) =>
    request<AuthoringSkillDoc[]>("/settings/authoring-skills", { method: "PUT", body: JSON.stringify(docs) }),
  listEntities: (type: EntityType) => request<Entity[]>(`/entities?type=${type}`),
  listWorkOrders: (status: WorkOrderStatus) => request<Entity[]>(`/entities?status=${status}`),
  getEntity: (id: string) => request<Entity>(`/entities/${id}`),
  createEntity: (input: { type: EntityType; title: string; body?: string; workType?: WorkType | null }) =>
    request<Entity>("/entities", { method: "POST", body: JSON.stringify(input) }),
  patchEntity: (
    id: string,
    patch: Partial<Pick<Entity, "title" | "body" | "status" | "assignee" | "workType">>,
    // overrideGate: the explicit human override for the draft→ready
    // completeness gate; ignored by every other patch.
    opts?: { overrideGate?: boolean },
  ) =>
    request<Entity>(`/entities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(opts?.overrideGate ? { ...patch, overrideGate: true } : patch),
    }),
  deleteEntity: (id: string) => request<{ ok: boolean }>(`/entities/${id}`, { method: "DELETE" }),
  subtree: (id: string) => request<Entity[]>(`/entities/${id}/subtree`),
  ancestors: (id: string) => request<Entity[]>(`/entities/${id}/ancestors`),
  transitions: (id: string) =>
    request<{ current: WorkOrderStatus; allowed: WorkOrderStatus[] }>(`/entities/${id}/transitions`),
  tree: (expand?: "chain") => request<FeatureTreeNode[]>(`/tree${expand ? "?expand=chain" : ""}`),
  linked: (id: string, type: LinkType) => request<Entity[]>(`/entities/${id}/linked/${type}`),
  linkedFrom: (id: string, type: LinkType) => request<Entity[]>(`/entities/${id}/linked-from/${type}`),
  context: (id: string) => request<WorkOrderContext>(`/entities/${id}/context`),
  contextHealth: (id: string) => request<ContextHealth>(`/entities/${id}/context/health`),
  documentHealth: (id: string) => request<DocumentHealth>(`/entities/${id}/health`),
  contextReceipts: (id: string) =>
    request<(ContextReceipt & { context: WorkOrderContext })[]>(`/entities/${id}/context/receipts`),
  completionReceipts: (id: string) => request<CompletionReceipt[]>(`/entities/${id}/completion-receipts`),
  link: (fromId: string, toId: string, type: LinkType) =>
    request<{ ok: boolean }>("/links", { method: "POST", body: JSON.stringify({ fromId, toId, type }) }),
  suggestions: (entityId: string) => request<Suggestion[]>(`/entities/${entityId}/suggestions`),
  revisions: (entityId: string) => request<Revision[]>(`/entities/${entityId}/revisions`),
  applySuggestion: (suggestionId: string, acceptedOpIndexes: number[]) =>
    request<{ entity: Entity; revision: Revision }>(`/suggestions/${suggestionId}/apply`, {
      method: "POST",
      body: JSON.stringify({ acceptedOpIndexes }),
    }),
  restore: (entityId: string, revisionId: string) =>
    request<{ entity: Entity; revision: Revision }>(`/entities/${entityId}/restore`, {
      method: "POST",
      body: JSON.stringify({ revisionId }),
    }),
  dismissSuggestion: (suggestionId: string) =>
    request<{ ok: boolean }>(`/suggestions/${suggestionId}`, { method: "DELETE" }),
  draft: (entityId: string) => request<Suggestion>(`/entities/${entityId}/draft`, { method: "POST" }),
  extract: (blueprintId: string) =>
    request<{ candidates: WorkOrderCandidate[] }>(`/entities/${blueprintId}/extract`, { method: "POST" }),
  acceptCandidate: (blueprintId: string, candidate: WorkOrderCandidate) =>
    request<Entity>(`/entities/${blueprintId}/work-orders`, { method: "POST", body: JSON.stringify(candidate) }),
  readiness: () => request<WorkOrderReadiness[]>("/work-orders/readiness"),
  pulse: () => request<ProjectPulse>("/pulse"),
  pulseKnowledge: () => request<KnowledgeHealth>("/pulse/knowledge"),
  pulseActivity: (limit?: number) =>
    request<ActivityEvent[]>(`/pulse/activity${limit !== undefined ? `?limit=${limit}` : ""}`),
  graph: () => request<GraphSnapshot>("/graph"),
  gaps: () => request<{ requirements: string[]; blueprints: string[]; artifacts: string[] }>("/graph/gaps"),
  criticalPath: () => request<{ path: string[] }>("/graph/critical-path"),
  review: (entityId: string) =>
    request<{ findings: Finding[]; ops: EditOp[] | null }>(`/entities/${entityId}/review`, { method: "POST" }),
  fileSuggestion: (targetId: string, source: SuggestionSource, ops: EditOp[]) =>
    request<Suggestion>("/suggestions", { method: "POST", body: JSON.stringify({ targetId, source, ops }) }),
  chat: (entityId: string, messages: ChatMessage[]) =>
    request<{ reply: string; suggestionId?: string }>(`/entities/${entityId}/chat`, {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),
};
