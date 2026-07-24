import type { View } from "../components/TopBar";

// Global keyboard map (WO#5 keyboard navigation). Kept pure so the "g"-chord
// state machine is unit-tested without a DOM; the App effect owns only the
// timer that expires a dangling "g". Every navigating action returns a target
// view the caller hands straight to `navigate({ view })`, so a shortcut and a
// TopBar click travel the exact same path.
export type KeyAction =
  | { kind: "navigate"; view: View }
  | { kind: "quickOpen" }
  | { kind: "none" };

export type KeyEventLike = { key: string; metaKey: boolean; ctrlKey: boolean };

// A "g" then <key> chord switches views (Gmail/Linear style). The prefix stays
// clear of the OS's ⌘-number tab bindings and never fights typing.
const VIEW_KEYS: Record<string, View> = {
  p: "pulse",
  d: "documents",
  b: "board",
  x: "xray",
  s: "settings",
};

// The chords, for the discoverability hint (QuickOpen footer). Kept beside the
// map they describe so the two can't drift.
export const VIEW_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "g p", label: "Pulse" },
  { keys: "g d", label: "Documents" },
  { keys: "g b", label: "Board" },
  { keys: "g x", label: "X-ray" },
  { keys: "g s", label: "Settings" },
];

// Resolve a keydown into an action plus the next armed state. `armed` is whether
// a "g" prefix is waiting for its target; `editable` is true when focus sits in
// a text field, where only the ⌘/Ctrl+K palette may fire (so typing a "g" never
// teleports you elsewhere).
export function resolveKey(
  e: KeyEventLike,
  armed: boolean,
  editable: boolean,
): { action: KeyAction; armed: boolean } {
  const key = e.key.toLowerCase();
  // ⌘/Ctrl+K opens the palette from anywhere, editable or not.
  if ((e.metaKey || e.ctrlKey) && key === "k") return { action: { kind: "quickOpen" }, armed: false };
  // Leave every other modifier chord (copy, the webview's own shortcuts) alone,
  // and never fold a modified key into the "g" chord.
  if (e.metaKey || e.ctrlKey) return { action: { kind: "none" }, armed: false };
  if (editable) return { action: { kind: "none" }, armed: false };
  // "g" (re)arms the chord; a target within the window switches views.
  if (key === "g") return { action: { kind: "none" }, armed: true };
  if (armed) {
    const view = VIEW_KEYS[key];
    return { action: view ? { kind: "navigate", view } : { kind: "none" }, armed: false };
  }
  return { action: { kind: "none" }, armed: false };
}
