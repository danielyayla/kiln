// Clipboard write, isolated so components stay declarative and the async
// success/failure toast lives at the call site. The Tauri webview and dev
// browser both expose the async Clipboard API in their (secure) context.
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
