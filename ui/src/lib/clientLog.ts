import type { Backend } from "../ipc/backend";

/**
 * Errors shown in the UI are also written to voxbox.log (the user can copy them
 * there, unlike a toast). Best effort: logging never throws and never blocks.
 */
let backend: Backend | null = null;
// Errors raised before the backend is known (boot) wait here, bounded.
const pending: { context: string; message: string }[] = [];
const MAX_PENDING = 20;
/** Same message from the same place within this delay is written once. */
const REPEAT_MS = 5000;
const lastWritten = new Map<string, number>();

export function setLogBackend(next: Backend | null) {
  backend = next;
  if (!next) return;
  for (const entry of pending.splice(0)) send(entry.context, entry.message);
}

export function logClientError(context: string, message: string) {
  const key = `${context}\u0000${message}`;
  const now = Date.now();
  const last = lastWritten.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return;
  lastWritten.set(key, now);
  if (lastWritten.size > 200) lastWritten.clear();
  if (!backend) {
    if (pending.length < MAX_PENDING) pending.push({ context, message });
    return;
  }
  send(context, message);
}

function send(context: string, message: string) {
  backend?.invoke("log_client_error", { context, message }).catch(() => undefined);
}

/** Uncaught errors and rejected promises of the page, in the log too. */
export function captureGlobalErrors(target: Window = window) {
  target.addEventListener("error", (e) => {
    logClientError("erreur JavaScript", e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message);
  });
  target.addEventListener("unhandledrejection", (e) => {
    const reason: unknown = e.reason;
    logClientError("promesse rejetée", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
}

/** Test hook. */
export function resetClientLog() {
  backend = null;
  pending.length = 0;
  lastWritten.clear();
}
