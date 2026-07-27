// Why the "Draft with agent" button is disabled — or null when drafting is
// allowed. The disabled condition itself is unchanged (in-flight draft, or
// the anchor lock: pending suggestions block a second one); this rule only
// names the reason so the button can explain itself instead of looking broken.
export function draftDisabledReason(opts: {
  drafting: boolean;
  pendingSuggestions: number;
}): string | null {
  if (opts.drafting) return "Drafting is already in progress.";
  if (opts.pendingSuggestions > 0) return "Resolve pending suggestions before drafting.";
  return null;
}
