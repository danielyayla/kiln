import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/client";
import { friendlyError } from "./lib/errors";
import { FeatureTree } from "./components/FeatureTree";
import { QuickOpen } from "./components/QuickOpen";
import { ArtifactsPanel } from "./components/ArtifactsPanel";
import { DocumentView } from "./components/DocumentView";
import { RightPanel } from "./components/RightPanel";
import { Board } from "./components/Board";
import { XRayView } from "./components/XRayView";
import { PulseView } from "./components/PulseView";
import { SettingsView } from "./components/SettingsView";
import { TopBar } from "./components/TopBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button, Input, ToastProvider, useToast } from "./components/ui";
import { navigate, routeAfterProjectSwitch, useRoute } from "./lib/route";
import { resolveKey } from "./lib/keyboard";
import { color, font, space } from "./theme";

// First-run welcome (BP-6): a fresh store gets a create CTA instead of an
// instruction to select something that doesn't exist yet.
function ZeroState({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState("");

  const create = useMutation({
    mutationFn: (t: string) => api.createEntity({ type: "requirement", title: t }),
    onSuccess: (entity) => {
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      onCreated(entity.id);
    },
    onError: (e) => toast(friendlyError(e)),
  });

  return (
    <div data-testid="zero-state" style={{ maxWidth: 460, margin: "18vh auto 0", textAlign: "center" }}>
      <h2 style={{ marginBottom: space(2) }}>Welcome to Kiln</h2>
      <p style={{ color: color.muted, fontSize: font.base, marginBottom: space(5) }}>
        Kiln keeps the chain from intent to shipped work: requirements nest into a feature tree,
        blueprints detail them, and work orders flow to your coding agents over MCP. Start with the
        first requirement — a feature or outcome you want to build.
      </p>
      <form
        style={{ display: "flex", gap: space(2), justifyContent: "center" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate(title.trim());
        }}
      >
        <Input
          autoFocus
          aria-label="First requirement title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Traceable work handoff"
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" type="submit" disabled={!title.trim() || create.isPending}>
          Create your first requirement
        </Button>
      </form>
    </div>
  );
}

// App shell (BP-6): top bar (view switcher + status) over three columns —
// navigator on the left, the opened document in the middle, and the
// knowledge-graph neighbourhood of the opened entity on the right. All state
// lives in the store behind the sidecar — the webview only renders and links.
export function App() {
  // Location is the source of truth (BP: Navigation & deep linking). `view`,
  // the opened document, and the right-panel tab all come from the URL hash,
  // so the app is addressable and survives reload. Pulse is home (Phase 11):
  // an empty hash resolves to it. `quickOpen` stays transient UI state.
  const { view, selectedId, panelTab } = useRoute();
  const [quickOpen, setQuickOpen] = useState(false);

  // Open a document: every navigator, dashboard, board, and search selection
  // routes through here — the compatibility shim for the old `onSelect(id)`.
  const openDoc = (id: string) => navigate({ view: "documents", selectedId: id });
  const clearSelection = () => navigate({ selectedId: null });

  // Shares the navigator's cache entry; used only to detect a fresh store.
  const tree = useQuery({ queryKey: ["tree", "chain"], queryFn: () => api.tree("chain") });
  const isFreshStore = tree.data?.length === 0;

  // Global keyboard (BP-6 ⌘K + WO#5 keyboard nav). One listener drives the
  // palette toggle and the "g <key>" view-switch chord; `resolveKey` is the pure
  // map (unit-tested), and view switches go through `navigate` so a shortcut and
  // a TopBar click share one path. A dangling "g" expires after a short window.
  useEffect(() => {
    let armed = false;
    let disarm: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const editable =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const { action, armed: next } = resolveKey(e, armed, editable);
      armed = next;
      clearTimeout(disarm);
      if (armed) disarm = setTimeout(() => (armed = false), 1500);
      if (action.kind === "quickOpen") {
        e.preventDefault();
        setQuickOpen((v) => !v);
      } else if (action.kind === "navigate") {
        e.preventDefault();
        navigate({ view: action.view });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(disarm);
    };
  }, []);

  return (
    <ToastProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <UpdateBanner />
        <TopBar
          view={view}
          onViewChange={(v) => navigate({ view: v })}
          onQuickOpen={() => setQuickOpen(true)}
          // A project switch swapped the whole workspace (the switcher already
          // activated the new store and cleared the query cache). Keep the
          // opened entity if it still exists in the new project; otherwise land
          // on Pulse (Navigation & deep linking — no more hard reset).
          onProjectSwitched={async () => {
            setQuickOpen(false);
            let exists = false;
            if (selectedId) {
              try {
                await api.getEntity(selectedId);
                exists = true;
              } catch {
                exists = false;
              }
            }
            const patch = routeAfterProjectSwitch(selectedId, exists);
            if (patch) navigate(patch, { replace: true });
          }}
        />
        {quickOpen && (
          <QuickOpen
            onClose={() => setQuickOpen(false)}
            onSelect={(id) => openDoc(id)}
          />
        )}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* The X-ray is a full-bleed canvas, the Pulse is a whole-project
              overview, and Settings is app config — none of them wants the
              document navigator. */}
          {view !== "xray" && view !== "pulse" && view !== "settings" && (
            <nav
              aria-label="Navigator"
              style={{
                width: 280,
                flexShrink: 0,
                borderRight: `1px solid ${color.border}`,
                padding: space(4),
                overflowY: "auto",
                background: color.surface,
              }}
            >
              <FeatureTree
                selectedId={selectedId}
                onSelect={(id) => openDoc(id)}
                onDeleted={(id) => {
                  if (selectedId === id) clearSelection();
                }}
              />
              <ArtifactsPanel selectedId={selectedId} onSelect={(id) => openDoc(id)} />
            </nav>
          )}
          <main
            style={{
              flex: 1,
              // The X-ray canvas manages its own space; the board wants every
              // horizontal pixel; documents read better with wider margins.
              padding:
                view === "xray"
                  ? 0
                  : view === "board"
                    ? space(4)
                    : `${space(6)}px ${space(8)}px`,
              overflowY: view === "xray" ? "hidden" : "auto",
              minWidth: 0,
            }}
          >
            {view === "xray" ? (
              <XRayView onSelect={(id) => openDoc(id)} />
            ) : view === "settings" ? (
              <SettingsView />
            ) : view === "pulse" ? (
              // An empty dashboard is worse than an empty state: a fresh store
              // gets the create-first-requirement CTA here too.
              isFreshStore ? (
                <ZeroState onCreated={(id) => openDoc(id)} />
              ) : (
                <PulseView onSelect={(id) => openDoc(id)} />
              )
            ) : view === "board" ? (
              <Board onSelect={(id) => openDoc(id)} />
            ) : selectedId ? (
              <DocumentView entityId={selectedId} onSelect={(id) => openDoc(id)} onDeleted={() => clearSelection()} />
            ) : isFreshStore ? (
              <ZeroState onCreated={(id) => openDoc(id)} />
            ) : (
              <p style={{ color: color.muted }}>
                Select a requirement or artifact to open its document — or press ⌘K to search.
              </p>
            )}
          </main>
          {view === "documents" && selectedId && (
            <RightPanel
              entityId={selectedId}
              onSelect={(id) => openDoc(id)}
              tab={panelTab ?? "graph"}
              // A tab switch is an in-place refinement, not a destination:
              // replace so Back skips past it to the previous location.
              onTabChange={(t) => navigate({ panelTab: t === "graph" ? null : t }, { replace: true })}
            />
          )}
        </div>
      </div>
    </ToastProvider>
  );
}
