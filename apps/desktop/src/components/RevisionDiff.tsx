import { useMemo } from "react";
import type { Revision } from "@kiln/core";
import { diffLines } from "../lib/diff";
import { Button } from "./ui";
import { color, font, radius, space } from "../theme";

// What restoring `revision` would change, against the current body (BP-6).
// Line rows reuse the editor's .kiln-ins/.kiln-del decoration styling:
// green = lines the restore brings back, red = lines it removes.
export function RevisionDiff({
  currentBody,
  revision,
  onRestore,
  restoring,
}: {
  currentBody: string;
  revision: Revision;
  onRestore: () => void;
  restoring: boolean;
}) {
  const diff = useMemo(() => diffLines(currentBody, revision.body), [currentBody, revision.body]);
  const identical = diff.every((l) => l.kind === "same");

  return (
    <div
      data-testid="revision-diff"
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        marginTop: space(1.5),
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space(2),
          padding: `${space(1.5)}px ${space(2.5)}px`,
          borderBottom: `1px solid ${color.border}`,
          background: color.surface,
          fontSize: font.sm,
          color: color.muted,
        }}
      >
        <span style={{ flex: 1 }}>
          {identical
            ? "This revision matches the current document."
            : "Changes if restored — green lines come back, red lines are removed."}
        </span>
        <Button data-testid="restore-revision" onClick={onRestore} disabled={identical || restoring}>
          {restoring ? "restoring…" : "Restore"}
        </Button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: space(2.5),
          maxHeight: 280,
          overflowY: "auto",
          fontSize: font.sm,
          fontFamily: "ui-monospace, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          background: color.bg,
        }}
      >
        {diff.map((line, i) => (
          <div key={i} className={line.kind === "added" ? "kiln-ins" : line.kind === "removed" ? "kiln-del" : undefined}>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
