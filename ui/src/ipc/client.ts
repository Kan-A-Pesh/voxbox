import type { Backend } from "./backend";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let backend: Backend | null = null;

/** The Tauri bridge inside the app, the in-memory mock in a plain browser. */
export async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (isTauri()) {
    backend = (await import("./tauri")).tauriBackend;
  } else {
    const { createMockBackend } = await import("./mock");
    const params = new URLSearchParams(window.location.search);
    backend = createMockBackend({
      myinstantsOffline: params.has("offline"),
      cableMissing: params.has("nocable"),
      // ?update simulates a newer release, ?update=fail one whose install fails.
      update: params.has("update")
        ? { version: "0.1.42", stepMs: 400, failWith: params.get("update") === "fail" ? "téléchargement interrompu (réseau)" : undefined }
        : null,
    });
  }
  return backend;
}

export type { Backend } from "./backend";
