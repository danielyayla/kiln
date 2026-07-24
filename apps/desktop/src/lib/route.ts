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

// `navigate` writes location with `history.pushState`/`replaceState`, which —
// unlike assigning `location.hash` — fire neither `hashchange` nor `popstate`.
// So the store notifies subscribers itself; it also listens to `popstate`
// (browser/OS back-forward) and `hashchange` (a manually edited hash).
const listeners = new Set<() => void>();
function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

function getSnapshot(): string {
  return window.location.hash;
}

// Subscribe a component to the current route. Re-renders on every navigation,
// browser back/forward, or manual hash edit.
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot);
  return parseHash(hash);
}

// In-app history depth, stashed in `history.state`. The app's first entry is
// depth 0 (a fresh load or a deep link has no in-app history behind it); each
// pushState deepens it, and back/forward restore the entry's own depth. This
// is what tells the Back control whether there is anywhere to go back to —
// `history.length` can't, since it counts entries from before the app loaded.
type RouteState = { kilnDepth?: number };

function currentDepth(): number {
  const state = window.history.state as RouteState | null;
  return typeof state?.kilnDepth === "number" ? state.kilnDepth : 0;
}

// True when an in-app Back would stay inside the app (depth > 0). Drives the
// Back control's disabled state; re-evaluated on every navigation and popstate.
export function useCanGoBack(): boolean {
  return useSyncExternalStore(subscribe, () => currentDepth() > 0);
}

export function goBack(): void {
  window.history.back();
}

// Deep links (WO#3). A location is shareable: the app's base URL plus the
// route's hash. Pasted into a fresh launch, `parseHash` on load restores the
// exact view + document + panel tab. `base` is injected so the construction is
// a pure, testable function; `locationBase()` supplies it at call sites.
export function linkForRoute(route: Route, base: string): string {
  return base + serializeRoute(route);
}

function locationBase(): string {
  return window.location.href.split("#")[0];
}

// A shareable link to the current location (TopBar "copy link").
export function currentLink(): string {
  return linkForRoute(parseHash(window.location.hash), locationBase());
}

// A shareable link straight to one entity's document (entity-header "copy
// link") — independent of whatever view you copy it from.
export function entityLink(id: string): string {
  return linkForRoute({ view: "documents", selectedId: id, panelTab: null, params: {} }, locationBase());
}

// One-hop cross-view jump (WO#4). The route patch for landing on an entity's
// Context tab in Documents in a single move — used by surfaces whose whole
// point IS the assembled context (X-ray peek, Pulse's pre-flight panel), so
// they skip the old open-then-switch-tab two-step. Pure so the target is
// unit-tested; call sites pass it straight to `navigate`.
export function contextRoute(id: string): Partial<Route> {
  return { view: "documents", selectedId: id, panelTab: "context" };
}

// After a project switch, decide where to land: keep the current location when
// its opened entity still exists in the new store, otherwise fall back cleanly
// to Pulse (a project is a separate store — the old id usually won't resolve).
// Returns `null` to mean "stay put"; a patch to mean "navigate there". Pure so
// the keep-or-reset rule is unit-tested without a store.
export function routeAfterProjectSwitch(selectedId: string | null, entityExists: boolean): Partial<Route> | null {
  if (selectedId && entityExists) return null;
  return { view: "pulse", selectedId: null, panelTab: null };
}

// The single write path. Every click, tab, and view switch routes through here
// so location stays the source of truth.
//
// `replace: true` is for in-place refinements (right-panel tab switches) that
// should not litter the back stack — back should skip past them to the real
// previous location. Everything else pushes a new entry, so Back is meaningful.
export function navigate(patch: Partial<Route>, opts: { replace?: boolean } = {}): void {
  const current = serializeRoute(parseHash(window.location.hash));
  const next = serializeRoute(mergeRoute(parseHash(window.location.hash), patch));
  // "#/pulse" and a bare "" are the same location on first load; a no-op
  // navigation must not push a phantom entry.
  if (next === current) return;

  if (opts.replace) {
    window.history.replaceState({ kilnDepth: currentDepth() } satisfies RouteState, "", next);
  } else {
    window.history.pushState({ kilnDepth: currentDepth() + 1 } satisfies RouteState, "", next);
  }
  emit();
}
