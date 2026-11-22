import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { Backend } from "./backend";

export const tauriBackend: Backend = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: (event, handler) => tauriListen(event, (e) => handler(e.payload as never)),
  async pickFiles({ title, extensions, multiple }) {
    const picked = await open({
      title,
      multiple,
      directory: false,
      filters: [{ name: title, extensions }],
    });
    if (picked === null) return null;
    return Array.isArray(picked) ? picked : [picked];
  },
  onFileDrop: (handler) =>
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "drop") handler({ type: "drop", paths: p.paths });
      else if (p.type === "leave") handler({ type: "leave" });
      else handler({ type: "over" });
    }),
};
