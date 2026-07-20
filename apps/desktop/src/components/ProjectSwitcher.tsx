import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import { friendlyError } from "../lib/errors";
import { createAndSwitch, switchToProject } from "../lib/project-switch";
import { Button, Input, RowMenu, useToast } from "./ui";
import { backdrop, color, font, radius, shadow, space } from "../theme";

// The project switcher (Projects feature): the always-visible active-project
// indicator in the TopBar, with the switcher menu attached. Switching and
// creating both run the lib/project-switch flow — activate on the sidecar,
// re-key per-project localStorage, clear the query cache (every cached query
// belongs to the old store), then let the shell reset to Pulse. The webview
// never sees a file path.
export function ProjectSwitcher({ onSwitched }: { onSwitched: (id: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const active = projects.data?.projects.find((p) => p.id === projects.data?.activeProject) ?? null;

  const deps = {
    activeProjectId: projects.data?.activeProject ?? null,
    activate: api.activateProject,
    storage: localStorage,
    clearCache: () => queryClient.clear(),
    onSwitched,
  };

  const switchMutation = useMutation({
    mutationFn: (id: string) => switchToProject(id, deps),
    onError: (e) => toast(friendlyError(e)),
  });

  const createMutation = useMutation({
    mutationFn: (projectName: string) =>
      createAndSwitch(projectName, { ...deps, create: api.createProject }),
    onSuccess: () => {
      setCreating(false);
      setName("");
    },
    onError: (e) => toast(friendlyError(e)),
  });

  // A store pinned outside the registry (KILN_DB_PATH dev runs) has no active
  // project; stay quiet rather than inventing a name.
  if (!projects.data || projects.data.projects.length === 0) return null;

  return (
    <>
      <RowMenu
        label="Switch project"
        trigger={
          <span
            data-testid="active-project"
            style={{ display: "inline-flex", alignItems: "center", gap: space(1), fontSize: font.sm }}
          >
            {active?.name ?? "Projects"}
            <span aria-hidden style={{ fontSize: font.xs, color: color.faint }}>
              ▾
            </span>
          </span>
        }
        triggerStyle={{
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: `${space(1)}px ${space(2)}px`,
          color: color.text,
          background: color.bg,
        }}
        items={[
          ...projects.data.projects.map((p) => ({
            label: p.id === projects.data.activeProject ? `✓ ${p.name}` : p.name,
            onSelect: () => switchMutation.mutate(p.id),
          })),
          { label: "New project…", onSelect: () => setCreating(true) },
        ]}
      />
      {creating && (
        <div
          data-testid="create-project-modal"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 30,
            background: backdrop,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
          }}
          onClick={() => setCreating(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !createMutation.isPending) createMutation.mutate(name.trim());
            }}
            style={{
              marginTop: "22vh",
              width: 380,
              background: color.bg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.lg,
              boxShadow: shadow,
              padding: space(5),
              display: "flex",
              flexDirection: "column",
              gap: space(3),
            }}
          >
            <strong style={{ fontSize: font.base }}>New project</strong>
            <p style={{ fontSize: font.sm, color: color.muted, margin: 0 }}>
              A project is a fully separate workspace — its own documents, board, and settings.
            </p>
            <Input
              autoFocus
              aria-label="Project name"
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space(2) }}>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!name.trim() || createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
