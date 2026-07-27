// Build the ratification queue: screen provisional decisions, group per feature, flag exceptions.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const out = process.argv[3];

const provisional = db.prepare(`
  SELECT d.id, d.title, d.body, d.meta,
         (SELECT u.title FROM edges e JOIN units u ON u.id=e.to_id
          WHERE e.from_id=d.id AND e.rel='governs' AND u.kind='intent') intent,
         (SELECT COUNT(*) FROM edges e WHERE e.to_id=d.id AND e.rel='governed_by') task_count
  FROM units d WHERE d.kind='decision' AND d.ratified=0`).all();

const ratified = db.prepare(`
  SELECT d.id, d.title, d.body,
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

const queue = new Map(); // intent -> rows
for (const d of provisional) {
  const meta = JSON.parse(d.meta);
  const flags = [];
  // near-duplicate of an already-ratified decision on the same intent
  for (const r of ratified.filter((r) => r.intent === d.intent)) {
    const o = overlap(d.title + " " + d.body, r.title + " " + r.body);
    if (o >= 0.6) { flags.push(`≈ duplicates ratified "${r.title.slice(0, 60)}" (${Math.round(o * 100)}%)`); break; }
  }
  // near-duplicate within the provisional set
  for (const p of provisional) {
    if (p.id === d.id || p.intent !== d.intent) continue;
    const o = overlap(d.title, p.title);
    if (o >= 0.75 && d.id < p.id) { flags.push(`≈ overlaps provisional "${p.title.slice(0, 60)}"`); break; }
  }
  if ((meta.excerpt || "").length < 25) flags.push("weak evidence: excerpt under 25 chars");
  if (!d.intent) flags.push("governs no intent");
  const row = { id: d.id, title: d.title, statement: d.body, category: meta.category, rejected: meta.rejected, excerpt: meta.excerpt, tasks: d.task_count, flags };
  const k = d.intent || "(no intent)";
  if (!queue.has(k)) queue.set(k, []);
  queue.get(k).push(row);
}

const L = [];
let clean = 0, flagged = 0;
L.push(`# Ratification queue — distilled decisions (provisional)`);
for (const [intent, rows] of [...queue.entries()].sort((a, b) => b[1].length - a[1].length)) {
  L.push(`\n## ${intent} — ${rows.length} decision(s)`);
  for (const r of rows) {
    const mark = r.flags.length ? "⚠" : "✓";
    r.flags.length ? flagged++ : clean++;
    L.push(`- ${mark} **[${r.category}] ${r.title}** (governs ${r.tasks} task(s))`);
    L.push(`   - ${r.statement.replace(/\n+/g, " ")}`);
    if (r.rejected) L.push(`   - rejected: ${String(r.rejected).replace(/\n+/g, " ")}`);
    L.push(`   - evidence: "${(r.excerpt || "").replace(/\n+/g, " ").slice(0, 160)}"`);
    for (const f of r.flags) L.push(`   - ⚠ ${f}`);
  }
}
L.unshift(`**${provisional.length} provisional** across ${queue.size} feature(s): **${clean} clean**, **${flagged} flagged**.\n`);
writeFileSync(out, L.join("\n"));
console.log(`queue: ${provisional.length} provisional, ${clean} clean, ${flagged} flagged, ${queue.size} features`);
const flaggedRows = [...queue.values()].flat().filter((r) => r.flags.length);
for (const r of flaggedRows) console.log(`FLAG [${r.category}] ${r.title} :: ${r.flags.join(" | ")}`);
