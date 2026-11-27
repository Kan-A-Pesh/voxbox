import { useSyncExternalStore } from "react";

/**
 * The AI import in flight (from files or from voice-models.com), shared by every panel instance:
 * progress events carry no id, so only one import runs at a time, and a reopened panel shows that
 * one instead of starting another.
 */
export type RunningImport = {
  name: string;
  progress: number;
  /** Set for an online import: the model being added and the current step. */
  online?: { url: string; stage: "download" | "convert" };
};

let running: RunningImport | null = null;
const subscribers = new Set<() => void>();

export function setRunning(next: RunningImport | null) {
  running = next;
  subscribers.forEach((notify) => notify());
}

export const getRunning = () => running;

const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
};

export const useRunningImport = () => useSyncExternalStore(subscribe, getRunning);
