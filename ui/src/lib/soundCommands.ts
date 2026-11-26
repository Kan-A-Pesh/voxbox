import type { Backend } from "../ipc/backend";
import { inOrder } from "./inOrder";

// Two requests in flight can reach the app in any order (each invoke is its own
// HTTP request), so "Tout arrêter" could overtake a "Jouer" clicked just before it.
// Sound commands therefore go one at a time (`inOrder`): each is sent once the
// previous one answered (the app answers them at once). Each carries this page's
// number, so the app ignores a command of a page since reloaded, and a play carries
// how many times the "stop all" shortcut had run when it was clicked, so a play
// clicked before a shortcut press never starts after it.
type SoundPage = { page: number; hotkeyStops: number };
type State = { listening: Promise<unknown> | null; page: Promise<SoundPage> | null; hotkeyStops: number | null };
const states = new WeakMap<Backend, State>();

function stateOf(backend: Backend): State {
  let state = states.get(backend);
  if (!state) {
    state = { listening: null, page: null, hotkeyStops: null };
    states.set(backend, state);
  }
  return state;
}

/** Listens to the shortcut's stops (again after a failure). */
function listenStops(backend: Backend, state: State): Promise<unknown> {
  if (!state.listening) {
    state.listening = backend
      .listen("sounds-stopped", (stops) => (state.hotkeyStops = Math.max(state.hotkeyStops ?? 0, stops)))
      .catch((e: unknown) => {
        state.listening = null;
        throw e;
      });
  }
  return state.listening;
}

/**
 * This page's number and the shortcut's count, asked once listening to the
 * shortcut's stops (so none is missed between the two), and asked again after a
 * failure, so one failure never blocks the sounds.
 */
function pageOf(backend: Backend): Promise<SoundPage> {
  const state = stateOf(backend);
  if (!state.page) {
    state.page = listenStops(backend, state)
      .then(() => backend.invoke("begin_page", {}))
      .then(
        (page) => {
          state.hotkeyStops = Math.max(state.hotkeyStops ?? 0, page.hotkeyStops);
          return page;
        },
        (e: unknown) => {
          state.page = null;
          throw e;
        },
      );
  }
  return state.page;
}

/** Asks the app for this page's number; the UI waits for it before its first click. */
export function beginSoundPage(backend: Backend): Promise<SoundPage> {
  return pageOf(backend);
}

/**
 * Runs `send` (a sound command for `page`; `stops` is the shortcut's stop count known
 * at this click) after every sound command sent before it.
 */
export function sendSoundCommand<T>(backend: Backend, send: (page: number, stops: number) => Promise<T>): Promise<T> {
  const known = stateOf(backend).hotkeyStops;
  // Unknown at this click (the page never answered): a count read later could be
  // newer than the click, so the command is refused rather than guessed.
  if (known === null) return Promise.reject(new Error("VoxBox se connecte encore au moteur de sons : réessaie dans un instant."));
  return inOrder(backend, "sound-commands", () => pageOf(backend).then((p) => send(p.page, known)));
}
