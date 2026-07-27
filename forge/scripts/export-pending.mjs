// Export distill-pending sources from forge.db into batch files for distiller agents.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const pending = db
  .prepare("SELECT id, title, body, meta FROM units WHERE kind='source' AND provisional_reason IS NOT NULL")
  .all()
  .map((s) => {
    const intent = db
      .prepare(`SELECT u.title t FROM edges e JOIN units u ON u.id=e.to_id
                WHERE e.from_id=? AND e.rel='cites' AND u.kind='intent'`)
      .get(s.id);
    const taskCount = db
      .prepare(`SELECT COUNT(*) n FROM edges e JOIN units t ON t.id=e.from_id
                WHERE e.to_id=? AND e.rel='cites' AND t.kind='task'`)
      .get(s.id).n;
    return {
      sourceId: s.id,
      title: s.title,
      governsIntent: intent?.t ?? null,
      taskCount,
      body: s.body,
    };
  });

const N = 4;
const batches = Array.from({ length: N }, () => []);
pending.forEach((s, i) => batches[i % N].push(s));
batches.forEach((b, i) => writeFileSync(`${process.argv[3]}/batch-${i}.json`, JSON.stringify(b, null, 2)));
console.log(`${pending.length} pending sources -> ${N} batches:`, batches.map((b) => b.length).join(", "));
console.log(pending.map((p) => `- ${p.title} (${p.taskCount} tasks)`).join("\n"));
