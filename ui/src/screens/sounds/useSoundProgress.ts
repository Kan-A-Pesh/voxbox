import { useCallback, useEffect, useState } from "react";
import { useVox } from "../../state/store";

export type Progress = Record<string, { positionMs: number; durationMs: number }>;

export type SoundProgress = {
  progress: Progress;
  /** A play the app accepted: it counts as playing (stoppable) until it ends, even
   * while it is still decoding and before its first progress event. */
  markStarting: (id: string) => void;
  /** The play was refused: it no longer counts as playing. */
  forget: (id: string) => void;
};

/** Playback positions from `engine` soundProgress / soundEnded events. */
export function useSoundProgress(): SoundProgress {
  const { backend } = useVox();
  const [progress, setProgress] = useState<Progress>({});
  const forget = useCallback(
    (id: string) =>
      setProgress((p) => {
        if (!(id in p)) return p;
        const next = { ...p };
        delete next[id];
        return next;
      }),
    [],
  );
  const markStarting = useCallback(
    (id: string) => setProgress((p) => (p[id] ? p : { ...p, [id]: { positionMs: 0, durationMs: 0 } })),
    [],
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    backend
      .listen("engine", (e) => {
        if (e.type === "soundProgress") {
          setProgress((p) => ({ ...p, [e.id]: { positionMs: e.positionMs, durationMs: e.durationMs } }));
        } else if (e.type === "soundEnded") {
          forget(e.id);
        }
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend, forget]);
  return { progress, markStarting, forget };
}
