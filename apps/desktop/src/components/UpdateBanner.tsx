import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "./ui";
import { color, font, space } from "../theme";

// In-app auto-update: one silent check at startup against the GitHub Releases
// manifest (tauri.conf.json plugins.updater). Install only ever happens after
// an explicit click — declining just dismisses the banner for the session.
// The check is a no-op outside a packaged Tauri build (dev browser, tests).
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<"idle" | "installing" | "error">("idle");

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    check()
      .then((u) => {
        if (!cancelled && u) setUpdate(u);
      })
      .catch(() => {
        // Offline or the repo has no release yet — stay quiet, the app works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const install = async () => {
    setState("installing");
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setState("error");
    }
  };

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(3),
        padding: `${space(2)}px ${space(4)}px`,
        fontSize: font.base,
        background: color.surface,
        borderBottom: `1px solid ${color.border}`,
      }}
    >
      <span style={{ flex: 1 }}>
        {state === "error"
          ? "Update failed to install — you can keep working; it will be offered again next launch."
          : `Kiln ${update.version} is available.`}
      </span>
      {state !== "error" && (
        <>
          <Button variant="primary" onClick={() => void install()} disabled={state === "installing"}>
            {state === "installing" ? "Installing…" : "Update and restart"}
          </Button>
          <Button onClick={() => setUpdate(null)} disabled={state === "installing"}>
            Not now
          </Button>
        </>
      )}
    </div>
  );
}
