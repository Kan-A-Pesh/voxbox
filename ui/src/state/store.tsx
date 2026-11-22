import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend, CommandArgs, CommandName, CommandResult } from "../ipc/backend";
import type { AppSettings, Snapshot } from "../ipc/contract";
import { getBackend } from "../ipc/client";

export interface Toast { id: number; kind: "info" | "error"; message: string }

interface Store {
  snapshot: Snapshot;
  backend: Backend;
  setSnapshot: (update: (s: Snapshot) => Snapshot) => void;
  /** Invoke a command; failures surface as an error toast and resolve to undefined. */
  call: <K extends CommandName>(cmd: K, args: CommandArgs<K>) => Promise<CommandResult<K> | undefined>;
  /** Optimistic settings patch, reconciled with the backend's answer (reverted on failure). */
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  toasts: Toast[];
  notify: (message: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Erreur inconnue du moteur audio.";
}

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; backend: Backend; snapshot: Snapshot };

export function VoxProvider({ children, backend: injected }: { children: ReactNode; backend?: Backend }) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const backend = injected ?? (await getBackend());
        const snapshot = await backend.invoke("get_snapshot", {});
        if (cancelled) return;
        setLoad({ kind: "ready", backend, snapshot });
        unlisten = await backend.listen("snapshot-changed", (s) =>
          setLoad((prev) => (prev.kind === "ready" ? { ...prev, snapshot: s } : prev)),
        );
        if (cancelled) unlisten();
      } catch (e) {
        if (!cancelled) setLoad({ kind: "error", message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [injected, attempt]);

  const notify = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, message }]);
    const words = message.split(/\s+/).length;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), Math.max(3000, words * 300));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const setSnapshot = useCallback((update: (s: Snapshot) => Snapshot) => {
    setLoad((prev) => (prev.kind === "ready" ? { ...prev, snapshot: update(prev.snapshot) } : prev));
  }, []);

  const backend = load.kind === "ready" ? load.backend : null;

  const call = useCallback(
    async <K extends CommandName>(cmd: K, args: CommandArgs<K>) => {
      if (!backend) return undefined;
      try {
        return await backend.invoke(cmd, args);
      } catch (e) {
        notify(errorMessage(e), "error");
        return undefined;
      }
    },
    [backend, notify],
  );

  const settingsRef = useRef<AppSettings | null>(null);
  useEffect(() => {
    settingsRef.current = load.kind === "ready" ? load.snapshot.settings : null;
  }, [load]);

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const before = settingsRef.current;
      if (!before) return;
      setSnapshot((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      const settings = await call("update_settings", { patch });
      if (settings) {
        setSnapshot((s) => ({ ...s, settings }));
        return;
      }
      // Rejected: the backend may have moved anyway (e.g. devices it could not
      // restore), so show what it actually holds instead of guessing a revert.
      const fresh = await backend?.invoke("get_snapshot", {}).catch(() => null);
      setSnapshot((s) =>
        fresh
          ? { ...s, settings: fresh.settings, status: fresh.status }
          : { ...s, settings: { ...s.settings, ...revert(before, patch) } },
      );
    },
    [backend, call, setSnapshot],
  );

  const value = useMemo<Store | null>(
    () =>
      load.kind === "ready"
        ? { snapshot: load.snapshot, backend: load.backend, setSnapshot, call, patchSettings, toasts, notify, dismiss }
        : null,
    [load, setSnapshot, call, patchSettings, toasts, notify, dismiss],
  );

  if (load.kind === "loading") return <BootScreen />;
  if (load.kind === "error")
    return <BootScreen error={load.message} onRetry={() => (setLoad({ kind: "loading" }), setAttempt((a) => a + 1))} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function revert(before: AppSettings, patch: Partial<AppSettings>): Partial<AppSettings> {
  const keys = Object.keys(patch) as (keyof AppSettings)[];
  return Object.fromEntries(keys.map((k) => [k, before[k]]));
}

function BootScreen({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="boot" role={error ? "alert" : "status"}>
      <div className="boot__logo">voxbox</div>
      {error ? (
        <>
          <p className="boot__text">Impossible de joindre le moteur audio : {error}</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>Réessayer</button>
        </>
      ) : (
        <p className="boot__text">Démarrage du moteur audio<span className="blink">_</span></p>
      )}
    </div>
  );
}

export function useVox(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useVox must be used inside <VoxProvider>");
  return store;
}
