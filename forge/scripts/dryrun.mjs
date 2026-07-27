// Forge migration dry-run: read-only analysis of the live Kiln store.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const [dbPath, reportPath] = process.argv.slice(2);
if (!dbPath || !reportPath) {
  console.error("usage: dryrun.mjs <kiln.db> <report.md>");
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
const cols = Object.fromEntries(
  tables.map((t) => [t, all(`PRAGMA table_info(${t})`).map((c) => c.name)]),
);

const entities = all("SELECT * FROM entities");
const links = all("SELECT * FROM links");
const byId = new Map(entities.map((e) => [e.id, e]));
const linksOf = (type) => links.filter((l) => l.type === type);
const parentOf = new Map(linksOf("child_of").map((l) => [l.from_id, l.to_id])); // child -> parent
const detailsOf = linksOf("details"); // blueprint -> requirement
const bpToReq = new Map(detailsOf.map((l) => [l.from_id, l.to_id]));
const implementsL = linksOf("implements"); // wo -> blueprint
const woToBp = new Map(implementsL.map((l) => [l.from_id, l.to_id]));
const refs = linksOf("references"); // requirement -> artifact
const deps = linksOf("depends_on");

// ---------- helpers ----------
const section = (body, name) => {
  const re = new RegExp(`^#{1,4}\\s*${name}[^\\n]*$`, "im");
  const m = re.exec(body || "");
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,4}\s+\S/m);
  return next === -1 ? rest : rest.slice(0, next);
};
const bullets = (text) => (text ? (text.match(/^\s*[-*]\s+\S/gm) || []).length : 0);
const isPhase = (t) => /^phase\s*\d+/i.test(t || "");

// ---------- requirements ----------
const reqs = entities.filter((e) => e.type === "requirement");
const root = reqs.find((r) => !parentOf.has(r.id));
const phases = reqs.filter((r) => isPhase(r.title));
const features = reqs.filter((r) => r !== root && !isPhase(r.title));
const reqRows = reqs.map((r) => {
  const kind = r === root ? "ROOT" : isPhase(r.title) ? "PHASE" : "FEATURE";
  const ng = bullets(section(r.body, "Non-goals"));
  const parent = byId.get(parentOf.get(r.id));
  return { r, kind, nonGoals: ng, parent };
});

// ---------- blueprints ----------
const bps = entities.filter((e) => e.type === "blueprint");
const bpRows = bps.map((b) => {
  const body = b.body || "";
  const kd = bullets(section(body, "Key decisions"));
  const conv = bullets(section(body, "(?:Conventions(?: & constraints| and constraints)?|Enforceable conventions)"));
  const hasKD = kd > 0 || /^#+\s*key decisions/im.test(body);
  const hasApproach = /^#+\s*approach/im.test(body);
  const cls = hasKD ? "conformant" : hasApproach ? "legacy-approach" : "ad-hoc";
  const req = byId.get(bpToReq.get(b.id));
  return { b, cls, kd, conv, req };
});
const multiBpReqs = [...detailsOf.reduce((m, l) => m.set(l.to_id, (m.get(l.to_id) || 0) + 1), new Map())]
  .filter(([, n]) => n > 1)
  .map(([id, n]) => ({ req: byId.get(id), n }));

// ---------- work orders ----------
const wos = entities.filter((e) => e.type === "work_order");
const woRows = wos.map((w) => {
  const bp = byId.get(woToBp.get(w.id));
  const req = bp ? byId.get(bpToReq.get(bp.id)) : null;
  const finalReq = req && isPhase(req.title) ? byId.get(parentOf.get(req.id)) : req;
  return { w, bp, req, reparented: !!(req && isPhase(req.title)), finalReq, deps: deps.filter((d) => d.from_id === w.id).length };
});
const degraded = woRows.filter((x) => !x.bp || !x.req);
const statusCounts = wos.reduce((m, w) => ((m[w.status] = (m[w.status] || 0) + 1), m), {});

// ---------- artifacts / suggestions / revisions / receipts ----------
const arts = entities.filter((e) => e.type === "artifact");
const pendingSug = tables.includes("suggestions") ? one("SELECT COUNT(*) n FROM suggestions").n : "n/a";
const revisions = tables.includes("revisions") ? one("SELECT COUNT(*) n FROM revisions").n : "n/a";
const rc = (t) => (tables.includes(t) ? one(`SELECT COUNT(*) n FROM ${t}`).n : "n/a");
const ctxReceipts = rc("context_receipts");
const compReceipts = rc("completion_receipts");
const verReceipts = rc("verification_receipts");

// root architecture blueprint conventions
const rootBp = bpRows.find((x) => x.req && x.req.id === root.id);

// ---------- decision volume ----------
const mechKD = bpRows.reduce((s, x) => s + x.kd, 0);
const mechConv = bpRows.reduce((s, x) => s + x.conv, 0);
const nonGoalDecisions = reqRows.reduce((s, x) => s + x.nonGoals, 0);
const legacyBps = bpRows.filter((x) => x.cls !== "conformant");

// ---------- report ----------
const L = [];
const p = (s = "") => L.push(s);
p(`# Forge migration dry-run — live store mapping report`);
p(`Store: ${dbPath} · generated read-only\n`);
p(`## Totals`);
p(`| Kiln | count | Forge disposition |`);
p(`|---|---|---|`);
p(`| requirements | ${reqs.length} | ${1} root Intent + ${features.length} feature Intents + ${phases.length} PHASE re-parents |`);
p(`| blueprints | ${bps.length} | dissolved → Decisions; all ${bps.length} bodies archived as Sources |`);
p(`| work orders | ${wos.length} | Tasks (status: ${Object.entries(statusCounts).map(([k, v]) => `${k} ${v}`).join(", ")}) |`);
p(`| artifacts | ${arts.length} | Sources |`);
p(`| pending suggestions | ${pendingSug} | must be 0 at freeze |`);
p(`| revisions | ${revisions} | archived as Source version history |`);
p(`| context receipts | ${ctxReceipts} | Receipts (immutable, aliased) — replay set |`);
p(`| completion receipts | ${compReceipts} | Receipts |`);
p(`| verification receipts | ${verReceipts} | Receipts |`);
p(`| id aliases needed | ${entities.length} | alias table rows |`);
p(``);
p(`## Decision volume (actual, parsed from bodies)`);
p(`- Mechanical from Key-decisions bullets: **${mechKD}**`);
p(`- Mechanical from Conventions/constraints bullets: **${mechConv}**`);
p(`- Scope Decisions from requirement Non-goals bullets: **${nonGoalDecisions}**`);
p(`- Root architecture conventions (in the above): ${rootBp ? `${rootBp.kd} KD + ${rootBp.conv} conventions` : "—"}`);
p(`- Blueprints needing agent distillation (no Key-decisions section): **${legacyBps.length}** of ${bps.length}`);
p(``);
p(`## Requirements — dispositions`);
p(`| Requirement | Kind | Non-goals→Decisions | Note |`);
p(`|---|---|---|---|`);
for (const x of reqRows)
  p(`| ${x.r.title.slice(0, 70)} | ${x.kind} | ${x.nonGoals} | ${x.kind === "PHASE" ? `re-parent tasks → "${(x.parent?.title || "?").slice(0, 40)}"` : ""} |`);
p(``);
p(`## Blueprints — classification`);
p(`| Blueprint | Class | KD bullets | Conv bullets | Details → |`);
p(`|---|---|---|---|---|`);
for (const x of bpRows.sort((a, b) => a.cls.localeCompare(b.cls)))
  p(`| ${x.b.title.slice(0, 60)} | ${x.cls} | ${x.kd} | ${x.conv} | ${(x.req?.title || "⚠ NONE").slice(0, 45)} |`);
p(``);
if (multiBpReqs.length) {
  p(`## Requirements with multiple details blueprints`);
  for (const m of multiBpReqs) p(`- "${m.req.title}" — ${m.n} blueprints (current-approach one must be marked before distillation)`);
  p(``);
}
p(`## Work orders — flags`);
p(`- Re-parented from PHASE requirements: **${woRows.filter((x) => x.reparented).length}**`);
p(`- Degraded links (no blueprint or no requirement): **${degraded.length}**`);
for (const d of degraded) p(`  - [${d.w.status}] ${d.w.title.slice(0, 80)} ${!d.bp ? "(no implements link)" : "(blueprint details no requirement)"}`);
p(`- depends_on edges: ${deps.length}`);
p(``);
p(`## Artifacts → Sources`);
for (const a of arts) p(`- ${a.title.slice(0, 90)} (referenced by ${refs.filter((r) => r.to_id === a.id).length} requirement(s))`);

writeFileSync(reportPath, L.join("\n"));
console.log(L.slice(0, 40).join("\n"));
console.log(`\n... full report written (${L.length} lines)`);
