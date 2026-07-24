// Agent access (bundled MCP server feature) — the pure render logic behind the
// Settings "Agent access" section, kept out of the JSX so it is unit-testable
// without a DOM. Every function here derives from the sidecar's status object
// alone (blueprint decision 7: the snippet is rendered client-side from status,
// never inferred): the UI is a pure function of `GET /agent-access`.

import type { AgentAccessStatus, ProjectList } from "./client";

// The Claude Code registration command — first-class per the blueprint. Built
// from status.endpoint and status.token verbatim so it can never drift from
// what the listener actually serves; regenerating the token re-renders it in
// place because the token flows straight through.
export function claudeMcpAddCommand(status: AgentAccessStatus): string {
  return `claude mcp add --transport http kiln ${status.endpoint} --header "Authorization: Bearer ${status.token}"`;
}

// The generic JSON config block, for any agent that reads an `mcpServers` map
// (the .mcp.json / claude_desktop_config.json shape). Same endpoint and token
// as the command above — two renderings of one source.
export function jsonConfigSnippet(status: AgentAccessStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        kiln: {
          type: "http",
          url: status.endpoint,
          headers: { Authorization: `Bearer ${status.token}` },
        },
      },
    },
    null,
    2,
  );
}

// Whether the connection snippets and the regenerate-token control should be
// shown: only when the listener is actually up (there is something to connect
// to). This is a superset of "hidden while disabled" — a disabled listener is
// never running — and also hides the snippet when enabled-but-bind-failed,
// where the error line explains why instead of offering a dead command.
export function showConnection(status: AgentAccessStatus): boolean {
  return status.running && status.token.length > 0;
}

// The "serve current project" re-pin prompt. Non-null ONLY when the app's
// active project differs from the pinned one and the active project is known —
// so the control appears exactly when active ≠ pinned and never re-pins on its
// own (it drives an explicit button). Covers the removed-pin case too: when
// nothing is pinned (`project` is null, e.g. after the pinned project was
// deleted), any active project differs, so the prompt offers to adopt it.
export function rePinPrompt(
  status: AgentAccessStatus,
  projects: ProjectList | undefined,
): { activeId: string; activeName: string; pinnedName: string | null } | null {
  const activeId = projects?.activeProject ?? null;
  if (activeId === null) return null;
  const pinnedId = status.project?.id ?? null;
  if (activeId === pinnedId) return null;
  const active = projects?.projects.find((p) => p.id === activeId);
  if (!active) return null;
  return { activeId, activeName: active.name, pinnedName: status.project?.name ?? null };
}

// The one-line status summary the UI renders next to the toggle. Derived from
// status alone; the actionable error (bind conflict, removed pin) takes over
// the line when present so the user always sees the reason, not a bare
// "stopped".
export function statusLine(status: AgentAccessStatus): {
  tone: "running" | "stopped" | "error";
  text: string;
} {
  if (status.error) return { tone: "error", text: status.error };
  if (status.running) {
    const where = status.project ? ` · serving “${status.project.name}”` : "";
    return { tone: "running", text: `Running on port ${status.port}${where}` };
  }
  return { tone: "stopped", text: status.enabled ? "Starting…" : "Stopped" };
}
