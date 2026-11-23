import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { AvailableUpdate, Backend } from "./backend";

/** A check that gets no answer gives up, the next one retries. */
const CHECK_TIMEOUT_MS = 30_000;
/** A stalled download fails (and says so) instead of keeping the pop-up open forever. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

function wrap(update: Update): AvailableUpdate {
  return {
    version: update.version,
    async install(onProgress) {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall(
        (event) => {
          if (event.event === "Started") total = event.data.contentLength ?? null;
          else if (event.event === "Progress") downloaded += event.data.chunkLength;
          onProgress({ downloaded, total, finished: event.event === "Finished" });
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
      // Windows exits during install and the installer starts the new version;
      // elsewhere the new version only runs after a restart.
      await relaunch();
    },
    release: () => update.close(),
  };
}

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
  updates: {
    currentVersion: () => getVersion(),
    async check() {
      // Every failure rejects, « Could not fetch a valid release JSON » included: the updater
      // reports a missing latest.json and any HTTP error (429, 5xx) alike, so it cannot mean
      // « no update ». A withdrawn release still clears the offer: releases/latest then serves
      // the previous release's older latest.json, and the check answers null.
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      return update ? wrap(update) : null;
    },
  },
};
