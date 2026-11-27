import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend, CommandArgs, CommandName, CommandResult } from "../ipc/backend";
import type { AppSettings, Snapshot, EngineStatus } from "../ipc/contract";
import { getBackend } from "../ipc/client";
import { logClientError, setLogBackend } from "../lib/clientLog";

export interface Toast { id: number; kind: "info" | "error"; message: string }

interface Store {
  snapshot: Snapshot;
  backend: Backend;
  setSnapshot: (update: (s: Snapshot) => Snapshot) => void;
  /** Invoke a command; failures surface as an error toast and resolve to undefined. */
  call: <K extends CommandName>(cmd: K, args: CommandArgs<K>) => Promise<CommandResult<K> | undefined>;
  /** Optimistic settings patch, reconciled with the backend's answer (reverted on failure). */
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** Optimistically activate a voice; only the latest choice may write what the backend answered. */
  selectVoice: (id: string) => Promise<void>;
  toasts: Toast[];
  /** `logged`: the message already comes from the app's log (engine events); others errors are written to it. */
  notify: (message: string, kind?: Toast["kind"], logged?: boolean) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);

/** Keeps the newest engine status: reads can resolve out of order. */
export function newerStatus(current: EngineStatus, incoming: EngineStatus): EngineStatus {
  return incoming.revision >= current.revision ? incoming : current;
}

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
  // Bumped by every voice choice and every pushed snapshot: only the latest may set the active voice.
  const selectSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const backend = injected ?? (await getBackend());
        // As soon as the bridge exists: a failing startup is written to the log too.
        setLogBackend(backend);
        const snapshot = await backend.invoke("get_snapshot", {});
        if (cancelled) return;
        setLoad({ kind: "ready", backend, snapshot });
        unlisten = await backend.listen("snapshot-changed", (s) => {
          // The pushed snapshot is authoritative (e.g. a voice hotkey): a voice choice still waiting for
          // its answer must not write an older active voice over it.
          selectSeq.current++;
          setLoad((prev) =>
            prev.kind === "ready" ? { ...prev, snapshot: { ...s, status: newerStatus(prev.snapshot.status, s.status) } } : prev,
          );
        });
        if (cancelled) unlisten();
      } catch (e) {
        logClientError("démarrage de l'interface", errorMessage(e));
        if (!cancelled) setLoad({ kind: "error", message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [injected, attempt]);

  const notify = useCallback((message: string, kind: Toast["kind"] = "info", logged = false) => {
    if (kind === "error" && !logged) logClientError("message d'erreur", message);
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

  // Settings answers can complete out of order, and other commands (e.g. set_active_voice) write settings
  // too: an answer only updates the keys it patched, and only those no newer patch has touched since.
  const patchSeq = useRef(0);
  const latestPatchOf = useRef<Partial<Record<keyof AppSettings, number>>>({});
  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const before = settingsRef.current;
      if (!before) return;
      const seq = ++patchSeq.current;
      const keys = Object.keys(patch) as (keyof AppSettings)[];
      keys.forEach((k) => (latestPatchOf.current[k] = seq));
      const ownKeys = () => keys.filter((k) => latestPatchOf.current[k] === seq);
      setSnapshot((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      const settings = await call("update_settings", { patch });
      if (settings) {
        setSnapshot((s) => ({ ...s, settings: { ...s.settings, ...pick(settings, ownKeys()) } }));
        return;
      }
      // Rejected: the backend may have moved anyway (e.g. devices it could not
      // restore), so show what it actually holds instead of guessing a revert.
      const fresh = await backend?.invoke("get_snapshot", {}).catch(() => null);
      setSnapshot((s) =>
        fresh
          ? { ...s, settings: { ...s.settings, ...pick(fresh.settings, ownKeys()) }, status: newerStatus(s.status, fresh.status) }
          : { ...s, settings: { ...s.settings, ...pick(before, ownKeys()) } },
      );
    },
    [backend, call, setSnapshot],
  );

  const selectVoice = useCallback(
    async (id: string) => {
      const seq = ++selectSeq.current;
      const previous = settingsRef.current?.activeVoiceId;
      setSnapshot((s) => ({ ...s, settings: { ...s.settings, activeVoiceId: id } }));
      const settings = await call("set_active_voice", { id });
      if (seq !== selectSeq.current) return;
      // Only the active voice: a full settings answer could carry older values of settings patched meanwhile.
      // On failure the engine kept the previous voice (the backend may have stored the new id before failing
      // to load it), so show that one and leave "Utiliser" available for a retry.
      const activeVoiceId = settings?.activeVoiceId ?? previous;
      if (!activeVoiceId) return;
      setSnapshot((s) => ({ ...s, settings: { ...s.settings, activeVoiceId } }));
    },
    [call, setSnapshot],
  );

  const value = useMemo<Store | null>(
    () =>
      load.kind === "ready"
        ? { snapshot: load.snapshot, backend: load.backend, setSnapshot, call, patchSettings, selectVoice, toasts, notify, dismiss }
        : null,
    [load, setSnapshot, call, patchSettings, selectVoice, toasts, notify, dismiss],
  );

  if (load.kind === "loading") return <BootScreen />;
  if (load.kind === "error")
    return <BootScreen error={load.message} onRetry={() => (setLoad({ kind: "loading" }), setAttempt((a) => a + 1))} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function pick(settings: AppSettings, keys: (keyof AppSettings)[]): Partial<AppSettings> {
  return Object.fromEntries(keys.map((k) => [k, settings[k]]));
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
