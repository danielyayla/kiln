// "2h ago"-style relative timestamp; falls back to the date once it stops
// being recent enough to reason about relatively. `now` is injectable so
// tests stay deterministic (lifted from PulseView in BP-15).
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return iso.slice(0, 10);
}
