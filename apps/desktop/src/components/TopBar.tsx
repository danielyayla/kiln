import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/client";
import { copyText } from "../lib/clipboard";
import { currentLink, goBack, useCanGoBack } from "../lib/route";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { Button, useToast } from "./ui";
import { color, font, radius, space } from "../theme";

export type View = "documents" | "board" | "xray" | "pulse" | "settings";

// Status dot: quiet when healthy, loud when something needs attention.
// The tooltip (title) carries the words; the dot itself is aria-labelled so
// tests and screen readers see the state without hovering.
function StatusDot({ state, label }: { state: "ok" | "warn" | "danger" | "pending"; label: string }) {
  const fill =
    state === "ok" ? color.ok : state === "warn" ? color.warn : state === "danger" ? color.danger : color.faint;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      style={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: fill,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

// The app shell's top bar (BP-6): brand, the only view switcher, and the
// connection/credential status cluster. `/health` is polled so a dead
// sidecar or missing model credentials surface here instead of as a
// surprise 503 mid-workflow.
export function TopBar({
  view,
  onViewChange,
  onQuickOpen,
  onProjectSwitched,
}: {
  view: View;
  onViewChange: (v: View) => void;
  onQuickOpen: () => void;
  onProjectSwitched: (id: string) => void;
}) {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    retry: 1,
    refetchInterval: 15_000,
  });

  // isError must win over data: a failed refetch keeps the last good payload
  // in `data`, so checking `data.ok` first would leave the dot green forever
  // after the sidecar dies.
  const sidecar: { state: "ok" | "danger" | "pending"; label: string } = health.isPending
    ? { state: "pending", label: "sidecar: connecting…" }
    : health.isError || !health.data?.ok
      ? { state: "danger", label: "sidecar: unreachable — is it running?" }
      : { state: "ok", label: "sidecar: connected" };

  const canGoBack = useCanGoBack();
  const toast = useToast();

  // Copy a shareable link to the current location: view + document + panel tab,
  // encoded in the hash so pasting it into a fresh launch restores the place.
  const copyLink = () =>
    copyText(currentLink()).then(
      () => toast("Link to this location copied.", "success"),
      () => toast("Couldn't copy the link."),
    );

  const provider: { state: "ok" | "warn" | "pending"; label: string } =
    health.isPending || health.isError
      ? { state: "pending", label: "model provider: checking…" }
      : health.data?.providerAvailable
        ? { state: "ok", label: "model provider: configured" }
        : {
            state: "warn",
            label: "model provider: not configured — add your API key in Settings to enable drafting/extraction",
          };

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(4),
        height: 44,
        flexShrink: 0,
        padding: `0 ${space(4)}px`,
        borderBottom: `1px solid ${color.border}`,
        background: color.surface,
      }}
    >
      {/* Browser-style back: steps through the in-app history the router
          builds. Disabled at the first entry, where there's nowhere to go. */}
      <Button
        variant="ghost"
        aria-label="Back"
        title="Back"
        disabled={!canGoBack}
        onClick={goBack}
        style={{ fontSize: font.lg, color: color.text, padding: `0 ${space(1)}px` }}
      >
        ‹
      </Button>
      {/* The brand is the home affordance: it always returns to the Pulse. */}
      <Button
        variant="ghost"
        aria-label="Home"
        onClick={() => onViewChange("pulse")}
        style={{ fontWeight: 700, fontSize: font.base, color: color.text, padding: `0 ${space(1)}px` }}
      >
        Kiln
      </Button>
      {/* The active project is always visible here — the sidebar is hidden on
          Pulse/X-ray/Settings, so the TopBar is the one constant surface. */}
      <ProjectSwitcher onSwitched={onProjectSwitched} />
      <div role="tablist" aria-label="View" style={{ display: "flex", gap: space(1.5) }}>
        <Button
          role="tab"
          aria-selected={view === "pulse"}
          variant={view === "pulse" ? "primary" : "ghost"}
          onClick={() => onViewChange("pulse")}
        >
          Pulse
        </Button>
        <Button
          role="tab"
          aria-selected={view === "documents"}
          variant={view === "documents" ? "primary" : "ghost"}
          onClick={() => onViewChange("documents")}
        >
          Documents
        </Button>
        <Button
          role="tab"
          aria-selected={view === "board"}
          variant={view === "board" ? "primary" : "ghost"}
          onClick={() => onViewChange("board")}
        >
          Board
        </Button>
        <Button
          role="tab"
          aria-selected={view === "xray"}
          variant={view === "xray" ? "primary" : "ghost"}
          onClick={() => onViewChange("xray")}
        >
          X-ray
        </Button>
      </div>
      <button
        aria-label="Quick open"
        onClick={onQuickOpen}
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: space(2),
          padding: `${space(1)}px ${space(2.5)}px`,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          background: color.bg,
          cursor: "pointer",
          fontSize: font.sm,
          color: color.muted,
        }}
      >
        Search
        <kbd
          style={{
            fontSize: font.xs,
            fontFamily: "inherit",
            padding: `0 ${space(1)}px`,
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            background: color.chip,
          }}
        >
          ⌘K
        </kbd>
      </button>
      {/* Copy a link to wherever you are — the app's answer to a missing URL
          bar. The location lives in the hash, so the copied link is resumable. */}
      <Button aria-label="Copy link" title="Copy link to this location" variant="ghost" onClick={copyLink}>
        🔗
      </Button>
      {/* Settings sits beside the status dots: the dots say what's wrong, the
          gear is where you fix it. */}
      <Button
        aria-label="Settings"
        title="Settings"
        variant={view === "settings" ? "primary" : "ghost"}
        onClick={() => onViewChange("settings")}
      >
        ⚙︎
      </Button>
      <div data-testid="status-cluster" style={{ display: "flex", alignItems: "center", gap: space(2.5) }}>
        <StatusDot state={sidecar.state} label={sidecar.label} />
        <StatusDot state={provider.state} label={provider.label} />
      </div>
    </header>
  );
}
