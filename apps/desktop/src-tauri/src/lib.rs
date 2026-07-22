// The shell is deliberately thin: all product logic lives in @kiln/core behind
// the sidecar API (BP-5). The webview talks to the sidecar over localhost; the
// Rust layer hosts the window and, in a packaged build, launches the bundled
// single-file sidecar binary.
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // In dev the sidecar is spawned by scripts/dev.mjs (via node, with
            // the --experimental-sqlite flag) on the fixed dev port, so the Rust
            // side must NOT also spawn one — that would collide on 4823. In a
            // packaged build there is no dev launcher, so we start the bundled
            // externalBin here. It binds 127.0.0.1:4823 and self-execs to add
            // the sqlite flag when needed.
            if !tauri::is_dev() {
                let sidecar = app
                    .shell()
                    .sidecar("kiln-sidecar")
                    .expect("kiln-sidecar binary should be bundled as an externalBin");
                let (_rx, _child) = sidecar
                    .spawn()
                    .expect("failed to spawn the kiln sidecar");
                // The child is tied to the app process lifetime; dropping the
                // handle here lets it run for the session.
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running kiln desktop");
}
