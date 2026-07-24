import { useSyncExternalStore } from "react";
import type { View } from "../components/TopBar";

// The app's location — the addressable source of truth behind every view
// switch and document open (BP: Navigation & deep linking, WO#1 router core).
// Encoded in the URL hash so it survives reload inside the Tauri webview
// (no server, custom/file protocol origin) and, in later work orders, powers
// history/back, deep links, and keyboard nav. This WO lands parity only.
export type PanelTab = "graph" | "chat" | "context";

export type Route = {
  view: View;
  // The opened document. Carried across every view (not just Documents) so
  // switching Board → Documents reopens the last document, matching the
  // pre-router behavior where this lived in React state.
  selectedId: string | null;
  // The active right-panel tab; null means the default (graph).
  panelTab: PanelTab | null;
  // Reserved for view-scoped params (X-ray feature focus, Board filters) that
  // later work orders wire in; parsed and preserved but not yet produced here.
  params: Record<string, string>;
};

const VIEWS: readonly View[] = ["pulse", "documents", "board", "xray", "settings"];
const PANELS: readonly PanelTab[] = ["graph", "chat", "context"];
const DEFAULT_VIEW: View = "pulse";

// `#/<view>?doc=<id>&panel=<tab>&<params>` — a stale or unknown view falls
// back to the home view (Pulse) rather than a blank app.
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const qIndex = raw.indexOf("?");
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = qIndex === -1 ? "" : raw.slice(qIndex + 1);
  const view = (VIEWS as readonly string[]).includes(path) ? (path as View) : DEFAULT_VIEW;

  const qp = new URLSearchParams(query);
  const doc = qp.get("doc");
  const panel = qp.get("panel");
  const params: Record<string, string> = {};
  for (const [k, v] of qp) if (k !== "doc" && k !== "panel") params[k] = v;

  return {
    view,
    selectedId: doc && doc.length > 0 ? doc : null,
    panelTab: panel && (PANELS as readonly string[]).includes(panel) ? (panel as PanelTab) : null,
    params,
  };
}

export function serializeRoute(route: Route): string {
  const qp = new URLSearchParams();
  if (route.selectedId) qp.set("doc", route.selectedId);
  if (route.panelTab && route.panelTab !== "graph") qp.set("panel", route.panelTab);
  for (const [k, v] of Object.entries(route.params)) qp.set(k, v);
  const query = qp.toString();
  return `#/${route.view}${query ? `?${query}` : ""}`;
}

// Merge a partial navigation over the current location: `undefined` keeps the
// current value, `null` clears it. This is what preserves `doc` across view
// switches and `panelTab` across document opens — the single behavior the old
// React state gave for free.
export function mergeRoute(current: Route, patch: Partial<Route>): Route {
  return {
    view: patch.view ?? current.view,
    selectedId: patch.selectedId === undefined ? current.selectedId : patch.selectedId,
    panelTab: patch.panelTab === undefined ? current.panelTab : patch.panelTab,
    params: patch.params ?? current.params,
  };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getSnapshot(): string {
  return window.location.hash;
}

// Subscribe a component to the current route. Re-renders on every hashchange —
// including the ones `navigate` triggers by assigning `location.hash`.
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot);
  return parseHash(hash);
}

// The single write path. Every click, tab, and view switch routes through here
// so location stays the source of truth. Assigning `location.hash` fires
// `hashchange`, which drives the re-render; history push/replace tuning is a
// later work order.
export function navigate(patch: Partial<Route>): void {
  const next = serializeRoute(mergeRoute(parseHash(window.location.hash), patch));
  // A leading "#/pulse" and a bare "" mean the same location on first load;
  // only write when the serialized hash actually changes to avoid a redundant
  // history entry.
  const currentNormalized = serializeRoute(parseHash(window.location.hash));
  if (next !== currentNormalized) window.location.hash = next;
}
