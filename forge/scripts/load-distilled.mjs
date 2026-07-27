// Load distilled decisions into forge.db as PROVISIONAL units, evidence-checked.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";

const db = new DatabaseSync(process.argv[2]); // forge.db
const outFiles = process.argv.slice(4);
const reportPath = process.argv[3];

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const insUnit = db.prepare(
  "INSERT INTO units (id,kind,title,body,status,ratified,ratified_via,provisional_reason,meta,created_at,updated_at) VALUES (?,?,?,?,NULL,0,NULL,?,?,?,?)",
);
const insEdge = db.prepare("INSERT OR IGNORE INTO edges (from_id,to_id,rel) VALUES (?,?,?)");
const { randomUUID } = await import("node:crypto");

const srcRow = db.prepare("SELECT id, title, body, meta FROM units WHERE id=? AND kind='source'");
const intentOf = db.prepare(`SELECT u.id FROM edges e JOIN units u ON u.id=e.to_id
  WHERE e.from_id=? AND e.rel='cites' AND u.kind='intent'`);
const tasksCiting = db.prepare(`SELECT t.id FROM edges e JOIN units t ON t.id=e.from_id
  WHERE e.to_id=? AND e.rel='cites' AND t.kind='task'`);

const report = { loaded: 0, rejectedExcerpt: [], rejectedShape: [], perSource: {}, emptySources: [] };
const seenSources = new Set();
const CATS = new Set(["design", "constraint", "scope"]);
const now = new Date().toISOString();

for (const f of outFiles) {
  const batch = JSON.parse(readFileSync(f, "utf8"));
  for (const entry of batch) {
    const src = srcRow.get(entry.sourceId);
    if (!src) { report.rejectedShape.push(`${f}: unknown sourceId ${entry.sourceId}`); continue; }
    seenSources.add(src.id);
    const intent = intentOf.get(src.id);
    const tasks = tasksCiting.all(src.id);
    const bodyN = norm(src.body);
    let count = 0;
    for (const d of entry.decisions || []) {
      if (!d.title || !d.statement || !CATS.has(d.category) || !d.excerpt) {
        report.rejectedShape.push(`${src.title}: malformed decision "${(d.title || "?").slice(0, 60)}"`);
        continue;
      }
      if (!bodyN.includes(norm(d.excerpt))) {
        report.rejectedExcerpt.push(`${src.title}: excerpt not found for "${d.title.slice(0, 60)}"`);
        continue;
      }
      const id = randomUUID();
      insUnit.run(
        id, "decision", d.title.slice(0, 120), d.statement,
        "distilled: awaiting ratification",
        JSON.stringify({ origin_source: src.id, category: d.category, rejected: d.rejected ?? null, excerpt: d.excerpt, distilled: true }),
        now, now,
      );
      insEdge.run(id, src.id, "cites");
      if (intent) insEdge.run(id, intent.id, "governs");
      for (const t of tasks) insEdge.run(t.id, id, "governed_by");
      count++; report.loaded++;
    }
    report.perSource[src.title] = count;
    if (count === 0) report.emptySources.push(src.title);
    // flip the source's distill-pending flag
    db.prepare(`UPDATE units SET provisional_reason=NULL,
      meta=json_set(meta,'$.distilled',json('true'),'$.distilled_yield',?) WHERE id=?`).run(count, src.id);
  }
}

report.sourcesProcessed = seenSources.size;
report.stillPending = db.prepare("SELECT COUNT(*) n FROM units WHERE kind='source' AND provisional_reason IS NOT NULL").get().n;
report.provisionalDecisions = db.prepare("SELECT COUNT(*) n FROM units WHERE kind='decision' AND ratified=0").get().n;
report.tasksNowGoverned = db.prepare(`SELECT COUNT(DISTINCT e.from_id) n FROM edges e JOIN units t ON t.id=e.from_id
  WHERE e.rel='governed_by' AND t.kind='task'`).get().n;
report.tasksUngoverned = db.prepare(`SELECT COUNT(*) n FROM units t WHERE kind='task'
  AND meta NOT LIKE '%"degraded":true%'
  AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id=t.id AND e.rel='governed_by')`).get().n;

writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, perSource: undefined }, null, 2));
