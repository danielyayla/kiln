// Apply ratification: ratify all provisional decisions except an exclusion list.
// Usage: node ratify-apply.mjs forge.db [skipId,skipId,...]
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
const skip = new Set((process.argv[3] || "").split(",").filter(Boolean));
const rows = db.prepare("SELECT id FROM units WHERE kind='decision' AND ratified=0").all();
const stamp = new Date().toISOString();
let ok = 0, skipped = 0;
for (const r of rows) {
  if (skip.has(r.id)) { skipped++; continue; }
  db.prepare(`UPDATE units SET ratified=1, provisional_reason=NULL,
    ratified_via='human batch-ratification ${stamp} (screened queue)' WHERE id=?`).run(r.id);
  ok++;
}
console.log(JSON.stringify({ ratified: ok, skipped,
  remainingProvisional: db.prepare("SELECT COUNT(*) n FROM units WHERE kind='decision' AND ratified=0").get().n }));
