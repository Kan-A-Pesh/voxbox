import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiPackUpdate } from "../ipc/contract";
import { getRunning } from "../screens/voices/aiImportRunning";
import { errorMessage, useVox } from "./store";
import { useUpdateDialogShown, useUpdates } from "./updates";
import { setPackInstalling } from "./packInstalling";

/** Pack version whose pop-up was answered « Plus tard »: it is not shown again, only the banner. */
export const AI_PACK_DISMISSED_KEY = "voxbox.aiPack.dismissed";
/** Pack version being installed when VoxBox closed: checked at the next launch. */
export const AI_PACK_PENDING_KEY = "voxbox.aiPack.pending";

export type AiPackPhase =
  | { kind: "none" }
  | { kind: "available"; update: AiPackUpdate }
  /** `progress` is 0..1; `finished`: downloaded and checked, VoxBox closes to install it. */
  | { kind: "installing"; update: AiPackUpdate; progress: number; finished: boolean }
  | { kind: "failed"; update: AiPackUpdate; message: string };

/** Outcome of the last check asked for (Réglages, explorer). */
export type AiPackCheck = { kind: "idle" } | { kind: "checking" } | { kind: "upToDate" } | { kind: "failed"; message: string };

interface AiPackState {
  phase: AiPackPhase;
  dialogOpen: boolean;
  manual: AiPackCheck;
  /** Looks now and opens the pop-up when a pack is found. */
  checkNow: () => void;
  /** The pop-up of the pack found, or a check when none is known yet. */
  offer: () => void;
  install: () => void;
  /** Closes the pop-up for this version; the banner stays. */
  later: () => void;
}

const Ctx = createContext<AiPackState | null>(null);

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private storage unavailable: the pop-up may come back, the next-launch check is skipped.
  }
}

/**
 * The « Voix IA » pack update. Checked once at launch; the pop-up is offered at launch only for
 * an installed pack (the pack is optional), and waits while the app's own update pop-up is shown.
 * `canLeave` is asked before installing (VoxBox closes), like for an app update.
 */
export function AiPackProvider({ children, canLeave }: { children: ReactNode; canLeave: () => boolean }) {
  const { backend, snapshot, notify } = useVox();
  const appUpdate = useUpdates();
  const [phase, setPhaseState] = useState<AiPackPhase>({ kind: "none" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [manual, setManual] = useState<AiPackCheck>({ kind: "idle" });
  const phaseRef = useRef<AiPackPhase>(phase);
  const setPhase = useCallback((next: AiPackPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const installed = snapshot.aiPack.installed;
  // A function, not a read of the ref: the phase can change while a check awaits.
  const currentPhase = useCallback(() => phaseRef.current, []);

  // VoxBox closed to install a pack: say whether it is there now (authorization refused, …).
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    const pending = Number(read(AI_PACK_PENDING_KEY));
    if (!pending) return;
    write(AI_PACK_PENDING_KEY, null);
    const version = snapshot.aiPack.version;
    if (version !== null && version >= pending) notify(`Pack Voix IA ${version} installé`);
    else notify("Le pack Voix IA n’a pas été mis à jour : l’installation a été annulée ou refusée par Windows.", "error");
  }, [notify, snapshot.aiPack.version]);

  const inFlight = useRef<Promise<AiPackUpdate | null> | null>(null);
  const runCheck = useCallback(
    async (asked: boolean) => {
      if (currentPhase().kind === "installing") return;
      if (asked) setManual({ kind: "checking" });
      inFlight.current ??= backend.invoke("ai_pack_check", {}).finally(() => {
        inFlight.current = null;
      });
      try {
        const update = await inFlight.current;
        const current = currentPhase();
        if (current.kind === "installing") return;
        if (!update) {
          setPhase({ kind: "none" });
          setDialogOpen(false);
        } else if (current.kind === "failed" && current.update.version === update.version) {
          // Same pack still failing: keep the message until retried.
        } else {
          setPhase({ kind: "available", update });
        }
        if (asked) setManual(update ? { kind: "idle" } : { kind: "upToDate" });
        const offered = asked || (installed && read(AI_PACK_DISMISSED_KEY) !== String(update?.version));
        if (update && offered) setDialogOpen(true);
      } catch (e) {
        if (asked) setManual({ kind: "failed", message: errorMessage(e) });
        // The launch check stays silent (offline, GitHub down).
        else console.warn("recherche du pack Voix IA impossible", e);
      }
    },
    [backend, currentPhase, installed, setPhase],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void runCheck(false), 0);
    return () => window.clearTimeout(first);
    // Once per launch: not again when the snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  const install = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "available" && current.kind !== "failed") return;
    const { update } = current;
    const refuse = (message: string) => {
      setPhase({ kind: "failed", update, message });
      setDialogOpen(true);
    };
    if (appUpdate.phase.kind === "installing") return refuse("Une mise à jour de VoxBox est en cours : attends qu’elle se termine.");
    if (getRunning()) return refuse("Une voix IA est en cours d’import : attends qu’il se termine, puis réessaie.");
    // VoxBox closes: unsaved work (a voice being edited) asks first.
    if (!canLeave()) return;
    setDialogOpen(true);
    setPhase({ kind: "installing", update, progress: 0, finished: false });
    setPackInstalling(true);
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await backend.listen("ai-pack-progress", ({ progress }) => {
          const now = phaseRef.current;
          if (now.kind === "installing" && !now.finished) setPhase({ ...now, progress });
        });
        write(AI_PACK_PENDING_KEY, String(update.version));
        await backend.invoke("ai_pack_install", { version: update.version });
        setPhase({ kind: "installing", update, progress: 1, finished: true });
      } catch (e) {
        write(AI_PACK_PENDING_KEY, null);
        setPackInstalling(false);
        setPhase({ kind: "failed", update, message: errorMessage(e) });
        // The offer may be stale (a newer pack published, or this one installed meanwhile):
        // refresh it, so « Réessayer » and the other buttons act on the current one.
        void runCheck(false);
      } finally {
        unlisten?.();
      }
    })();
  }, [appUpdate.phase.kind, backend, canLeave, runCheck, setPhase]);

  const later = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind === "installing") return;
    if (current.kind !== "none") write(AI_PACK_DISMISSED_KEY, String(current.update.version));
    setDialogOpen(false);
  }, []);

  const value = useMemo<AiPackState>(
    () => ({
      phase,
      dialogOpen,
      manual,
      checkNow: () => void runCheck(true),
      offer: () => (phase.kind === "none" ? void runCheck(true) : setDialogOpen(true)),
      install,
      later,
    }),
    [phase, dialogOpen, manual, runCheck, install, later],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * True while the pack pop-up is on screen. It waits behind the app's update pop-up, except while
 * installing: the pack's progress stays in front until VoxBox closes.
 */
export function useAiPackDialogShown(): boolean {
  const { dialogOpen, phase } = useAiPack();
  const appDialogShown = useUpdateDialogShown();
  return dialogOpen && phase.kind !== "none" && (phase.kind === "installing" || !appDialogShown);
}

/** Either modal pop-up is on screen: native events (file drops) wait too. */
export function useModalShown(): boolean {
  const packShown = useAiPackDialogShown();
  const appShown = useUpdateDialogShown();
  return packShown || appShown;
}

export function useAiPack(): AiPackState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiPack outside AiPackProvider");
  return ctx;
}
