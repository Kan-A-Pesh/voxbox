import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AvailableUpdate } from "../ipc/backend";
import { errorMessage, useVox } from "./store";
import { isPackInstalling, usePackInstalling } from "./packInstalling";

/** The app looks for a newer release at launch, then this often. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Version whose pop-up was answered « Plus tard »: it is not shown again, only the banner. */
export const DISMISSED_KEY = "voxbox.update.dismissed";

export type UpdatePhase =
  | { kind: "none" }
  | { kind: "available"; update: AvailableUpdate }
  /** `progress` is 0..1, or null while the size is unknown; `finished`: the installer is starting. */
  | { kind: "installing"; update: AvailableUpdate; progress: number | null; finished: boolean }
  | { kind: "failed"; update: AvailableUpdate; message: string };

/** Outcome of the last check asked for in Réglages. */
export type ManualCheck = { kind: "idle" } | { kind: "checking" } | { kind: "upToDate" } | { kind: "failed"; message: string };

interface UpdatesState {
  currentVersion: string | null;
  phase: UpdatePhase;
  dialogOpen: boolean;
  manual: ManualCheck;
  /** Réglages → À propos: look now, and show the pop-up again if there is one. */
  checkNow: () => void;
  install: () => void;
  /** Closes the pop-up for this version; the banner stays. */
  later: () => void;
  openDialog: () => void;
}

const Ctx = createContext<UpdatesState | null>(null);

/** Frees a native update handle; a failure there only costs a little memory. */
function release(update: AvailableUpdate | null | undefined) {
  update?.release().catch((e) => console.warn("mise à jour non libérée", e));
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Private storage unavailable: the pop-up may come back at the next launch.
  }
}

/**
 * `canLeave` is asked before installing (the app restarts): a screen holding unsaved work can
 * refuse, like it does for navigation.
 */
export function UpdatesProvider({ children, canLeave }: { children: ReactNode; canLeave: () => boolean }) {
  const { backend } = useVox();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [phase, setPhaseState] = useState<UpdatePhase>({ kind: "none" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [manual, setManual] = useState<ManualCheck>({ kind: "idle" });
  // Read synchronously by checks and clicks; written together with the state.
  const phaseRef = useRef<UpdatePhase>(phase);
  const setPhase = useCallback((next: UpdatePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const disposed = useRef(false);
  // A function, not an inline test: the phase can change while a check awaits.
  const installing = useCallback(() => phaseRef.current.kind === "installing", []);

  // Adopts the result of a check. This provider owns every update object: the one it replaces
  // (or receives too late, under an install) is released, the one it keeps stays usable.
  const adopt = useCallback(
    (update: AvailableUpdate | null) => {
      const previous = phaseRef.current;
      // Under an install, or once the app is gone: nobody will use it.
      if (previous.kind === "installing" || disposed.current) {
        release(update);
        return;
      }
      if (previous.kind !== "none" && previous.update !== update) release(previous.update);
      if (!update) {
        setPhase({ kind: "none" });
        setDialogOpen(false);
      } else if (previous.kind === "failed" && previous.update.version === update.version) {
        // Same version still failing to install: keep the message until retried.
        setPhase({ kind: "failed", update, message: previous.message });
      } else {
        setPhase({ kind: "available", update });
      }
    },
    [setPhase],
  );

  // One check at a time: a manual check joins the one in progress instead of racing it.
  const inFlight = useRef<Promise<AvailableUpdate | null> | null>(null);
  const runCheck = useCallback(
    async (asked: boolean) => {
      if (installing()) return;
      if (asked) setManual({ kind: "checking" });
      inFlight.current ??= backend.updates
        .check()
        .then((update) => {
          adopt(update);
          return update;
        })
        .finally(() => {
          inFlight.current = null;
        });
      try {
        const update = await inFlight.current;
        if (asked) setManual(update ? { kind: "idle" } : { kind: "upToDate" });
        if (update && !installing() && (asked || readDismissed() !== update.version)) setDialogOpen(true);
      } catch (e) {
        if (asked) setManual({ kind: "failed", message: errorMessage(e) });
        // Automatic checks stay silent (offline, GitHub down): the next one retries.
        else console.warn("recherche de mise à jour impossible", e);
      }
    },
    [adopt, backend, installing],
  );

  useEffect(() => {
    let alive = true;
    backend.updates
      .currentVersion()
      .then((v) => alive && setCurrentVersion(v))
      .catch((e) => console.warn("version de l'app inconnue", e));
    // At launch (once the first render is on screen), then every CHECK_EVERY_MS.
    const first = window.setTimeout(() => void runCheck(false), 0);
    const timer = window.setInterval(() => void runCheck(false), CHECK_EVERY_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [backend, runCheck]);

  // Unmounted: free the handle held, and make a check still in flight drop its own.
  useEffect(() => {
    disposed.current = false;
    const phase = phaseRef;
    return () => {
      disposed.current = true;
      const held = phase.current;
      if (held.kind === "available" || held.kind === "failed") release(held.update);
    };
  }, []);

  const install = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "available" && current.kind !== "failed") return;
    // The Voix IA pack is being installed and VoxBox is about to close for it: not both.
    if (isPackInstalling()) return;
    // VoxBox restarts: unsaved work (a voice being edited) asks first.
    if (!canLeave()) return;
    const { update } = current;
    setDialogOpen(true);
    setPhase({ kind: "installing", update, progress: null, finished: false });
    update
      .install(({ downloaded, total, finished }) => {
        if (phaseRef.current.kind !== "installing") return;
        setPhase({ kind: "installing", update, progress: total ? Math.min(1, downloaded / total) : null, finished });
      })
      .catch((e) => {
        // The app went away during the install: nobody will retry this handle.
        if (disposed.current) release(update);
        else setPhase({ kind: "failed", update, message: errorMessage(e) });
      });
  }, [canLeave, setPhase]);

  const later = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind === "installing") return;
    if (current.kind !== "none") writeDismissed(current.update.version);
    setDialogOpen(false);
  }, []);

  const value = useMemo<UpdatesState>(
    () => ({
      currentVersion,
      phase,
      dialogOpen,
      manual,
      checkNow: () => void runCheck(true),
      install,
      later,
      openDialog: () => setDialogOpen(true),
    }),
    [currentVersion, phase, dialogOpen, manual, runCheck, install, later],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * True while the update pop-up is on screen (modal: the rest of the app ignores input). It
 * waits while the Voix IA pack is being installed: that pop-up stays in front.
 */
export function useUpdateDialogShown(): boolean {
  const { dialogOpen, phase } = useUpdates();
  const packInstalling = usePackInstalling();
  return dialogOpen && phase.kind !== "none" && !packInstalling;
}

export function useUpdates(): UpdatesState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUpdates outside UpdatesProvider");
  return ctx;
}
