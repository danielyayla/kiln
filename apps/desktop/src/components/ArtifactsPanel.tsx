import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import { timeAgo } from "../lib/time";
import { stickyHeader } from "./FeatureTree";
import { Chevron, SectionHeader, UploadButton } from "./ui";
import { color, font, radius, space } from "../theme";

const OPEN_KEY = "kiln.nav.artifactsOpen";

// Artifact upload (BP-5): a file becomes an `artifact` entity whose body is
// the file's text — from there it's referenceable by any requirement. The
// section collapses (BP-6) and remembers its state like the tree does.
export function ArtifactsPanel({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "false");

  const artifacts = useQuery({ queryKey: ["entities", "artifact"], queryFn: () => api.listEntities("artifact") });

  const toggle = () => {
    setOpen((prev) => {
      localStorage.setItem(OPEN_KEY, String(!prev));
      return !prev;
    });
  };

  const upload = useMutation({
    mutationFn: ({ title, body }: { title: string; body: string }) =>
      api.createEntity({ type: "artifact", title, body }),
    onSuccess: (entity) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["entities", "artifact"] });
      onSelect(entity.id);
    },
    onError: (e) => setError(String(e)),
  });

  async function onFileChosen(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const body = await file.text();
      upload.mutate({ title: file.name, body });
    } catch {
      setError(`could not read ${file.name} as text`);
    }
  }

  const count = artifacts.data?.length ?? 0;

  return (
    <section aria-label="Artifacts" style={{ marginTop: space(6) }}>
      <button
        aria-expanded={open}
        onClick={toggle}
        style={{
          ...stickyHeader,
          display: "flex",
          alignItems: "center",
          gap: space(1),
          width: "100%",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Chevron open={open} />
        <SectionHeader style={{ margin: 0 }}>Artifacts{count > 0 ? ` · ${count}` : ""}</SectionHeader>
      </button>
      {open && (
        <div style={{ marginTop: space(1.5) }}>
          {count === 0 && <p style={{ color: color.muted, margin: 0 }}>No artifacts yet.</p>}
          <ul data-testid="artifact-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {/* Newest first — recent source material is what you reach for;
                one line per row so eleven artifacts stay eleven rows. */}
            {[...(artifacts.data ?? [])]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
              .map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => onSelect(a.id)}
                    title={a.title}
                    className={`k-tree-row${a.id === selectedId ? " k-tree-row--selected" : ""}`}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: space(2),
                      width: "100%",
                      textAlign: "left",
                      padding: `2px ${space(1.5)}px`,
                      border: "none",
                      borderRadius: radius.sm,
                      fontWeight: a.id === selectedId ? 600 : 400,
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.title}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: font.xs, color: color.faint }}>
                      {timeAgo(a.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          <div style={{ marginTop: space(2) }}>
            <UploadButton
              label="Upload artifact"
              disabled={upload.isPending}
              onFileChosen={(files) => void onFileChosen(files)}
            >
              {upload.isPending ? "uploading…" : "+ Upload file"}
            </UploadButton>
          </div>
          {error && <p style={{ color: color.danger }}>{error}</p>}
        </div>
      )}
    </section>
  );
}
