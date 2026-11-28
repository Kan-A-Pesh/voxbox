import { useSyncExternalStore } from "react";

/**
 * The « Voix IA » pack is being downloaded or installed: VoxBox is about to close, so the app's
 * own update waits (its pop-up stays hidden, its install is refused). Shared outside the React
 * providers because the app updater's provider wraps the pack's.
 */
let installing = false;
const subscribers = new Set<() => void>();

export function setPackInstalling(next: boolean) {
  installing = next;
  subscribers.forEach((notify) => notify());
}

export const isPackInstalling = () => installing;

const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
};

export const usePackInstalling = () => useSyncExternalStore(subscribe, isPackInstalling);
