// Forge mechanical pass: Kiln snapshot -> fresh forge.db (five primitives).
// Deterministic only. Distillation (26 legacy blueprints, 7 phase bodies) is NOT done here.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const [snapshotPath, forgePath, reportPath] = process.argv.slice(2);
const src = new DatabaseSync(snapshotPath, { readOnly: true });
const A = (sql) => src.prepare(sql).all();

// ---------- freeze precondition (before any destination is created) ----------
const suggestionsTable = src
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suggestions'")
  .get();
if (suggestionsTable && !process.argv.includes("--allow-pending")) {
  const pendingSuggestions = src
    .prepare(`SELECT s.id, e.type, e.title FROM suggestions s JOIN entities e ON e.id = s.target_id`)
    .all();
  if (pendingSuggestions.length) {
    console.error(
      `Refusing to migrate: ${pendingSuggestions.length} pending suggestion(s) — unresolved content that would be silently dropped. Resolve them in the app first (or pass --allow-pending to override):`,
    );
    for (const p of pendingSuggestions) console.error(`  - [${p.type}] ${p.title}`);
    process.exit(1);
  }
}

const dst = new DatabaseSync(forgePath);
dst.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE units (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('intent','decision','task','source','receipt')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT,
    ratified INTEGER NOT NULL DEFAULT 0,
    ratified_via TEXT,
    provisional_reason TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE edges (
    from_id TEXT NOT NULL, to_id TEXT NOT NULL, rel TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, rel)
  );
  CREATE INDEX edges_to ON edges(to_id, rel);
  CREATE TABLE aliases (
    kiln_id TEXT PRIMARY KEY, forge_id TEXT NOT NULL,
    kiln_type TEXT NOT NULL, disposition TEXT NOT NULL
  );
`);
const insUnit = dst.prepare(
  "INSERT INTO units (id,kind,title,body,status,ratified,ratified_via,provisional_reason,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
);
const insEdge = dst.prepare("INSERT OR IGNORE INTO edges (from_id,to_id,rel) VALUES (?,?,?)");
const insAlias = dst.prepare("INSERT INTO aliases (kiln_id,forge_id,kiln_type,disposition) VALUES (?,?,?,?)");
const unit = (u) => {
  const id = randomUUID();
  insUnit.run(id, u.kind, u.title, u.body ?? "", u.status ?? null, u.ratified ? 1 : 0,
    u.ratified_via ?? null, u.provisional_reason ?? null, JSON.stringify(u.meta ?? {}),
    u.created_at ?? new Date().toISOString(), u.updated_at ?? u.created_at ?? new Date().toISOString());
  return id;
};

// ---------- load Kiln ----------
const entities = A("SELECT * FROM entities");
const links = A("SELECT * FROM links");
const byId = new Map(entities.map((e) => [e.id, e]));
const L = (t) => links.filter((l) => l.type === t);
const parentOf = new Map(L("child_of").map((l) => [l.from_id, l.to_id]));
const bpToReq = new Map(L("details").map((l) => [l.from_id, l.to_id]));
const woToBp = new Map(L("implements").map((l) => [l.from_id, l.to_id]));

const isPhase = (t) => /^phase\s*\d+/i.test(t || "");
const section = (body, name) => {
  const m = new RegExp(`^#{1,4}\\s*${name}[^\\n]*$`, "im").exec(body || "");
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,4}\s+\S/m);
  return next === -1 ? rest : rest.slice(0, next);
};
const bulletList = (text) =>
  text ? (text.match(/^\s*[-*]\s+[\s\S]*?(?=^\s*[-*]\s+|\s*$)/gm) || []).map((b) => b.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean) : [];
const decisionTitle = (b) => {
  const plain = b.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const cut = plain.split(/\s+—\s+|\.\s/)[0];
  return (cut.length > 120 ? cut.slice(0, 117) + "…" : cut) || plain.slice(0, 120);
};
const rejectedOf = (b) => {
  const m = /rejected:?\s*([\s\S]+)/i.exec(b);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

const stats = { intents: 0, decisions: 0, tasks: 0, sources: 0, receipts: 0, edges: 0, flags: [] };
const edge = (f, t, r) => { insEdge.run(f, t, r); stats.edges++; };

// Effective feature-intent target for a requirement id (phases resolve to parent).
const featureTarget = (reqId) => {
  let r = byId.get(reqId);
  while (r && isPhase(r.title)) r = byId.get(parentOf.get(r.id));
  return r ?? null;
};

// ---------- 1. requirements -> Intents (root + features); phases -> Sources ----------
const reqs = entities.filter((e) => e.type === "requirement");
const reqIntent = new Map(); // kiln req id -> forge intent id (features + root only)
for (const r of reqs) {
  if (isPhase(r.title)) continue;
  const id = unit({
    kind: "intent", title: r.title, body: r.body, ratified: 1,
    ratified_via: "migrated: human-authored/accepted in Kiln",
    meta: { origin: r.id }, created_at: r.created_at, updated_at: r.updated_at,
  });
  reqIntent.set(r.id, id);
  insAlias.run(r.id, id, "requirement", "intent");
  stats.intents++;
}
for (const r of reqs) {
  if (isPhase(r.title)) continue;
  const p = parentOf.get(r.id);
  if (p) { const t = featureTarget(p); if (t) edge(reqIntent.get(r.id), reqIntent.get(t.id), "part_of"); }
}
const phaseSource = new Map();
for (const r of reqs.filter((r) => isPhase(r.title))) {
  const t = featureTarget(parentOf.get(r.id));
  const id = unit({
    kind: "source", title: `Archived phase document: ${r.title}`, body: r.body, ratified: 1,
    ratified_via: "archive", provisional_reason: "distill-pending: phase body may hold constraints",
    meta: { origin: r.id, origin_type: "phase-requirement", reparent_to: t?.id },
    created_at: r.created_at, updated_at: r.updated_at,
  });
  phaseSource.set(r.id, id);
  insAlias.run(r.id, id, "requirement", "phase->source");
  if (t) edge(id, reqIntent.get(t.id), "cites");
  stats.sources++;
}

// ---------- 2. Non-goals -> scope Decisions ----------
for (const r of reqs) {
  if (isPhase(r.title)) continue;
  for (const b of bulletList(section(r.body, "Non-goals"))) {
    const id = unit({
      kind: "decision", title: `Declined: ${decisionTitle(b)}`, body: b, ratified: 1,
      ratified_via: "verbatim extract from ratified document",
      meta: { origin: r.id, category: "scope" }, created_at: r.created_at, updated_at: r.updated_at,
    });
    edge(id, reqIntent.get(r.id), "governs");
    stats.decisions++;
  }
}

// ---------- 3. blueprints -> archived Sources + mechanical Decisions ----------
const bpSource = new Map();
const bpDecisions = new Map(); // kiln bp id -> forge decision ids
for (const b of entities.filter((e) => e.type === "blueprint")) {
  const reqId = bpToReq.get(b.id);
  const target = reqId ? featureTarget(reqId) : null;
  const hasKD = /^#+\s*key decisions/im.test(b.body || "");
  const srcId = unit({
    kind: "source", title: `Archived blueprint: ${b.title}`, body: b.body, ratified: 1,
    ratified_via: "archive",
    provisional_reason: hasKD ? null : "distill-pending: decisions not yet extracted",
    meta: { origin: b.id, origin_type: "blueprint", conformant: hasKD },
    created_at: b.created_at, updated_at: b.updated_at,
  });
  bpSource.set(b.id, srcId);
  insAlias.run(b.id, srcId, "blueprint", "blueprint->source");
  stats.sources++;
  if (target && reqIntent.get(target.id)) edge(srcId, reqIntent.get(target.id), "cites");

  const ids = [];
  const kdBullets = bulletList(section(b.body, "Key decisions"));
  const convBullets = bulletList(section(b.body, "(?:Conventions(?: & constraints| and constraints)?|Enforceable conventions)"));
  for (const [cat, list] of [["design", kdBullets], ["constraint", convBullets]]) {
    for (const bl of list) {
      const id = unit({
        kind: "decision", title: decisionTitle(bl), body: bl, ratified: 1,
        ratified_via: "verbatim extract from ratified document",
        meta: { origin: b.id, category: cat, rejected: rejectedOf(bl) },
        created_at: b.created_at, updated_at: b.updated_at,
      });
      ids.push(id);
      edge(id, srcId, "cites");
      if (target && reqIntent.get(target.id)) edge(id, reqIntent.get(target.id), "governs");
      stats.decisions++;
    }
  }
  bpDecisions.set(b.id, ids);
}

// ---------- 4. work orders -> Tasks ----------
const woTask = new Map();
for (const w of entities.filter((e) => e.type === "work_order")) {
  const bpId = woToBp.get(w.id);
  const reqId = bpId ? bpToReq.get(bpId) : null;
  const target = reqId ? featureTarget(reqId) : null;
  const degraded = !bpId || !reqId;
  const id = unit({
    kind: "task", title: w.title, body: w.body, status: w.status, ratified: 1,
    ratified_via: "migrated: human-authored/accepted in Kiln",
    meta: {
      origin: w.id, work_type: w.work_type ?? "feature", criticality: w.criticality ?? "routine",
      assignee: w.assignee, degraded: degraded || undefined,
      reparented: reqId && isPhase(byId.get(reqId)?.title || "") ? reqId : undefined,
    },
    created_at: w.created_at, updated_at: w.updated_at,
  });
  woTask.set(w.id, id);
  insAlias.run(w.id, id, "work_order", degraded ? "task(degraded-archived)" : "task");
  stats.tasks++;
  if (degraded) stats.flags.push(`degraded task archived: [${w.status}] ${w.title}`);
  if (target && reqIntent.get(target.id)) edge(id, reqIntent.get(target.id), "fulfills");
  if (bpId) {
    edge(id, bpSource.get(bpId), "cites");
    for (const d of bpDecisions.get(bpId) ?? []) edge(id, d, "governed_by");
  }
}
for (const l of L("depends_on")) {
  const f = woTask.get(l.from_id), t = woTask.get(l.to_id);
  if (f && t) edge(f, t, "depends_on");
}

// ---------- 5. artifacts -> Sources (+ citations from intents) ----------
for (const a of entities.filter((e) => e.type === "artifact")) {
  const id = unit({
    kind: "source", title: a.title, body: a.body, ratified: 1, ratified_via: "archive",
    meta: { origin: a.id, origin_type: "artifact" }, created_at: a.created_at, updated_at: a.updated_at,
  });
  insAlias.run(a.id, id, "artifact", "source");
  stats.sources++;
  for (const l of L("references").filter((l) => l.to_id === a.id)) {
    const t = featureTarget(l.from_id);
    const intent = t && reqIntent.get(t.id);
    if (intent) edge(intent, id, "cites");
  }
}

// ---------- 6. receipts ----------
const hasTable = (t) =>
  !!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const rowsOf = (t) => (hasTable(t) ? A(`SELECT * FROM ${t}`) : []);
const receiptRows = [
  ...rowsOf("context_receipts").map((r) => ({ r, k: "context" })),
  ...rowsOf("completion_receipts").map((r) => ({ r, k: "completion" })),
  ...rowsOf("verification_receipts").map((r) => ({ r, k: "verification" })),
];
for (const { r, k } of receiptRows) {
  const task = woTask.get(r.work_order_id);
  const woTitle = byId.get(r.work_order_id)?.title ?? r.work_order_id;
  const id = unit({
    kind: "receipt", title: `${k} receipt — ${woTitle}`.slice(0, 200), body: "",
    ratified: 1, ratified_via: "immutable record",
    meta: { origin: r.id, receipt_kind: k, payload: r }, created_at: r.created_at, updated_at: r.created_at,
  });
  stats.receipts++;
  if (task) edge(id, task, "records");
  else stats.flags.push(`receipt ${r.id} (${k}) has no task for WO ${r.work_order_id}`);
}

// ---------- 7. revisions -> version Sources ----------
let revCount = 0;
for (const rev of rowsOf("revisions")) {
  const targetAlias = dst.prepare("SELECT forge_id FROM aliases WHERE kiln_id = ?").get(rev.entity_id);
  const tEnt = byId.get(rev.entity_id);
  const id = unit({
    kind: "source", title: `Revision of ${tEnt?.title ?? rev.entity_id} @ ${rev.created_at}`.slice(0, 200),
    body: rev.body, ratified: 1, ratified_via: "archive",
    meta: { origin: rev.id, origin_type: "revision", of: rev.entity_id },
    created_at: rev.created_at, updated_at: rev.created_at,
  });
  stats.sources++; revCount++;
  if (targetAlias) edge(id, targetAlias.forge_id, "version_of");
}

// ---------- integrity checks ----------
const q = (sql) => dst.prepare(sql).get().n;
const checks = [
  ["every non-degraded task fulfills an intent",
    q(`SELECT COUNT(*) n FROM units t WHERE kind='task' AND meta NOT LIKE '%"degraded":true%'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id=t.id AND e.rel='fulfills')`)],
  ["every decision governs something", q(`SELECT COUNT(*) n FROM units d WHERE kind='decision'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id=d.id AND e.rel='governs')`)],
  ["every receipt records a task", q(`SELECT COUNT(*) n FROM units r WHERE kind='receipt'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id=r.id AND e.rel='records')`)],
  ["dangling edges", q(`SELECT COUNT(*) n FROM edges e WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.id=e.from_id)
       OR NOT EXISTS (SELECT 1 FROM units u WHERE u.id=e.to_id)`)],
  ["intents without part_of except root", q(`SELECT COUNT(*) - 1 n FROM units i WHERE kind='intent'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id=i.id AND e.rel='part_of')`)],
];

// receipt replay (light): every context receipt's payload WO id resolves via alias to a task
let replayOk = 0, replayFail = 0;
for (const r of rowsOf("context_receipts"))
  woTask.get(r.work_order_id) ? replayOk++ : replayFail++;

const kindCounts = Object.fromEntries(
  dst.prepare("SELECT kind, COUNT(*) c FROM units GROUP BY kind").all().map((r) => [r.kind, r.c]),
);
const relCounts = Object.fromEntries(
  dst.prepare("SELECT rel, COUNT(*) c FROM edges GROUP BY rel").all().map((r) => [r.rel, r.c]),
);
const pending = dst.prepare("SELECT COUNT(*) n FROM units WHERE provisional_reason IS NOT NULL").get().n;

const out = { kindCounts, relCounts, aliases: dst.prepare("SELECT COUNT(*) n FROM aliases").get().n,
  revisionsMigrated: revCount, distillPending: pending,
  replay: { ok: replayOk, fail: replayFail },
  checks: checks.map(([name, n]) => ({ name, violations: n })),
  flags: stats.flags };
writeFileSync(reportPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
