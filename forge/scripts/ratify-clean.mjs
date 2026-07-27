// Ratify all provisional decisions that pass the screen; hold flagged ones. Same screen logic as ratify-queue.mjs.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
const provisional = db.prepare(`
  SELECT d.id, d.title, d.body, d.meta,
         (SELECT u.title FROM edges e JOIN units u ON u.id=e.to_id
          WHERE e.from_id=d.id AND e.rel='governs' AND u.kind='intent') intent
  FROM units d WHERE d.kind='decision' AND d.ratified=0`).all();
const ratified = db.prepare(`
  SELECT d.title, d.body,
         (SELECT u.title FROM edges e JOIN units u ON u.id=e.to_id
          WHERE e.from_id=d.id AND e.rel='governs' AND u.kind='intent') intent
  FROM units d WHERE d.kind='decision' AND d.ratified=1`).all();

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 3));
const overlap = (a, b) => {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let n = 0; for (const t of ta) if (tb.has(t)) n++;
  return n / Math.min(ta.size, tb.size);
};

const stamp = new Date().toISOString();
let ok = 0; const held = [];
for (const d of provisional) {
  const meta = JSON.parse(d.meta);
  let flag = null;
  for (const r of ratified.filter((r) => r.intent === d.intent))
    if (overlap(d.title + " " + d.body, r.title + " " + r.body) >= 0.6) { flag = "dup-of-ratified"; break; }
  if (!flag) for (const p of provisional)
    if (p.id !== d.id && p.intent === d.intent && overlap(d.title, p.title) >= 0.75 && d.id < p.id) { flag = "overlap-provisional"; break; }
  if (!flag && (meta.excerpt || "").length < 25) flag = "weak-evidence";
  if (!flag && !d.intent) flag = "no-intent";
  if (flag) { held.push({ id: d.id, title: d.title, flag }); continue; }
  db.prepare(`UPDATE units SET ratified=1, provisional_reason=NULL,
    ratified_via='batch-ratification ${stamp} (user-instructed, screened queue)' WHERE id=?`).run(d.id);
  ok++;
}
console.log(JSON.stringify({ ratified: ok, held }, null, 2));
