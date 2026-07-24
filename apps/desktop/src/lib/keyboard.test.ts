import { describe, expect, it } from "vitest";
import { resolveKey, VIEW_SHORTCUTS, type KeyEventLike } from "./keyboard";

const k = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

describe("resolveKey — palette", () => {
  it("⌘K and Ctrl+K open the palette from anywhere, editable or not", () => {
    expect(resolveKey(k("k", { metaKey: true }), false, false).action).toEqual({ kind: "quickOpen" });
    expect(resolveKey(k("k", { ctrlKey: true }), false, false).action).toEqual({ kind: "quickOpen" });
    expect(resolveKey(k("K", { metaKey: true }), false, true).action).toEqual({ kind: "quickOpen" });
  });

  it("disarms a dangling g when the palette opens", () => {
    expect(resolveKey(k("k", { metaKey: true }), true, false).armed).toBe(false);
  });
});

describe("resolveKey — g-chord view switch", () => {
  it("arms on g without navigating", () => {
    expect(resolveKey(k("g"), false, false)).toEqual({ action: { kind: "none" }, armed: true });
  });

  it("g then a mapped key navigates and disarms", () => {
    expect(resolveKey(k("p"), true, false)).toEqual({ action: { kind: "navigate", view: "pulse" }, armed: false });
    expect(resolveKey(k("d"), true, false).action).toEqual({ kind: "navigate", view: "documents" });
    expect(resolveKey(k("b"), true, false).action).toEqual({ kind: "navigate", view: "board" });
    expect(resolveKey(k("x"), true, false).action).toEqual({ kind: "navigate", view: "xray" });
    expect(resolveKey(k("s"), true, false).action).toEqual({ kind: "navigate", view: "settings" });
  });

  it("is case-insensitive for both the prefix and the target", () => {
    expect(resolveKey(k("G"), false, false).armed).toBe(true);
    expect(resolveKey(k("P"), true, false).action).toEqual({ kind: "navigate", view: "pulse" });
  });

  it("g then an unmapped key disarms and does nothing", () => {
    expect(resolveKey(k("z"), true, false)).toEqual({ action: { kind: "none" }, armed: false });
  });

  it("a target key without the g prefix does nothing (no accidental teleport)", () => {
    expect(resolveKey(k("p"), false, false)).toEqual({ action: { kind: "none" }, armed: false });
  });

  it("re-arms on a second g", () => {
    expect(resolveKey(k("g"), true, false).armed).toBe(true);
  });
});

describe("resolveKey — never fights typing", () => {
  it("does not arm on g while a text field is focused", () => {
    expect(resolveKey(k("g"), false, true)).toEqual({ action: { kind: "none" }, armed: false });
  });

  it("does not navigate on a target key while editable, and disarms", () => {
    expect(resolveKey(k("p"), true, true)).toEqual({ action: { kind: "none" }, armed: false });
  });

  it("leaves other modifier chords alone and disarms a pending g", () => {
    expect(resolveKey(k("c", { metaKey: true }), true, false)).toEqual({ action: { kind: "none" }, armed: false });
  });
});

describe("VIEW_SHORTCUTS", () => {
  it("documents exactly the five g-chords, each with a display label", () => {
    expect(VIEW_SHORTCUTS.map((s) => s.keys)).toEqual(["g p", "g d", "g b", "g x", "g s"]);
    expect(VIEW_SHORTCUTS.every((s) => s.label.length > 0)).toBe(true);
  });
});
