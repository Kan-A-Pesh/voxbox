// In-memory backend used when the UI runs outside Tauri (browser dev, screenshots, tests).
// It mirrors the contract semantics of src-tauri/src/commands.rs closely enough to drive every screen.
import type { AvailableUpdate, Backend, CommandArgs, CommandName, CommandResult, EventName, FileDropEvent, Unlisten } from "./backend";
import type { DeviceSelection, Devices, Events, RemoteSound, SearchPage, Snapshot, Sound, VoicePreset, HotkeyAction } from "./contract";
import {
  AI_MODELS, AI_VOICES, BUILTIN_VOICES, CUSTOM_VOICES, EFFECT_CATALOG, HOTKEYS, MYINSTANTS_TITLES, SETTINGS, SOUNDS,
} from "./mockData";
import { beepWavDataUri } from "../lib/beep";
import { sameAction } from "../lib/hotkeys";
import { clampRvcParams } from "../lib/rvcParams";

export interface MockOptions {
  /** Simulate MyInstants being unreachable. */
  myinstantsOffline?: boolean;
  /** Simulate a machine without VB-Cable installed. */
  cableMissing?: boolean;
  /** Artificial latency per command (ms). */
  latencyMs?: number;
  /** Emit animated meter events. Disabled in tests. */
  meters?: boolean;
  /** Speed of the AI import simulation (ms per progress step). */
  aiImportStepMs?: number;
  /** How long a MyInstants play "downloads" before it starts (0: at once). */
  remoteDownloadMs?: number;
  /** Saved devices point to a USB headset that is no longer plugged in. */
  unpluggedHeadset?: boolean;
  /** A newer release is published (null: this version is the latest). */
  update?: MockUpdate | null;
}

export interface MockUpdate {
  version: string;
  /** The install fails with this message instead of restarting. */
  failWith?: string;
  /** Delay between download progress steps (ms). */
  stepMs?: number;
}

/** Version the mock app runs. */
export const MOCK_APP_VERSION = "0.1.41";

/** Same rule as `sanitize_devices` in src-tauri/src/store.rs: unplugged devices go back to the default. */
export function sanitizeDevices(selection: DeviceSelection, available: Devices): DeviceSelection {
  const keep = (id: string | null, list: { id: string }[]) => (id && list.some((d) => d.id === id) ? id : null);
  return {
    input: keep(selection.input, available.inputs),
    cable: keep(selection.cable, available.outputs),
    monitor: keep(selection.monitor, available.outputs),
  };
}

export interface MockBackend extends Backend {
  /** Test hook: push a state change as if a global hotkey had fired. */
  simulateExternalChange(mutate: (s: Snapshot) => void): void;
  /** Test hook: simulate an OS file drop. */
  simulateDrop(paths: string[]): void;
  /** Test hook: one OS drag-and-drop event on its own (over, leave or drop). */
  simulateDragEvent(e: FileDropEvent): void;
  /** Test hook: the engine stops after a device disappears (only an `engine` event, like the Rust runtime). */
  simulateDeviceLoss(message: string): void;
  /** Test hook: the "stop all" global shortcut (it stops everything and sends `sounds-stopped`). */
  simulateHotkeyStopAll(): void;
  /** Test hook: the webview loads a page again (a reload): the sounds stop, the page number moves on. */
  simulatePageLoad(): void;
  /** Test hook: the engine stopped a playback (only an `engine` event). */
  simulateSoundEnded(id: string): void;
  /** Test hook: an accepted play could not start (its end, then `sound-failed`, like the app). */
  simulateSoundFailed(id: string, message: string): void;
  /** Test hook: the engine restarted on its own (only an `engine` event). */
  simulateRecovery(): void;
  /** Test hook: a retry found a more precise reason (quiet `statusChanged` event). */
  simulateRetryFailure(message: string): void;
  /** Test hook: running on the defaults because the saved devices are missing (quiet `statusChanged`). */
  simulateFallback(inputName: string): void;
  /** Test hook: true once a screen listens to OS file drops. */
  hasDropListener(): boolean;
  /** Invocation log, oldest first. */
  calls: { cmd: CommandName; args: unknown }[];
  /** Test hook: publish (or withdraw, with null) a newer release. */
  setUpdate(update: MockUpdate | null): void;
  /** Test hook: how many times the app checked for an update. */
  updateChecks(): number;
  /** Test hook: true once an update was installed and the app restarted. */
  restarted(): boolean;
  /** Test hook: most update checks ever running at the same time. */
  maxConcurrentChecks(): number;
  /** Test hook: how many update objects were released. */
  releasedUpdates(): number;
  /** Test hook: checks wait until the returned function is called. */
  holdUpdateChecks(): () => void;
  /** Test hook: installs stop after their download until the returned function is called. */
  holdInstalls(): () => void;
  dispose(): void;
}

const PAGE_SIZE = 24;
const clone = <T,>(v: T): T => structuredClone(v);

function slug(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function remote(title: string, i: number): RemoteSound {
  const id = `${slug(title)}-${i}`;
  return {
    title,
    mp3Url: beepWavDataUri(220 + ((i * 97) % 660)),
    pageUrl: `https://www.myinstants.com/fr/instant/${id}/`,
  };
}

function baseName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "");
}

export function createMockBackend(options: MockOptions = {}): MockBackend {
  const { latencyMs = 0, meters = true, aiImportStepMs = 120, remoteDownloadMs = 0 } = options;
  let published: MockUpdate | null = options.update ?? null;
  let checks = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let releasedCount = 0;
  let checkGate: Promise<void> | null = null;
  let installGate: Promise<void> | null = null;
  let hasRestarted = false;
  let remotePlays = 0;
  const cableFound = !options.cableMissing;

  const state: Snapshot = {
    settings: options.unpluggedHeadset
      ? { ...clone(SETTINGS), devices: { input: "usb-headset-mic", cable: null, monitor: "usb-headset-out" } }
      : clone(SETTINGS),
    status: {
      running: true,
      inputName: "Shure MV7 (USB)",
      cableName: cableFound ? "CABLE Input (VB-Audio Virtual Cable)" : null,
      monitorName: "Casque (Arctis 7)",
      cableFound,
      latencyMs: 18,
      lastError: null,
      restarting: false,
      fallback: false,
      revision: 0,
    },
    voices: clone([...BUILTIN_VOICES, ...AI_VOICES, ...CUSTOM_VOICES]),
    effectCatalog: clone(EFFECT_CATALOG),
    sounds: clone(SOUNDS),
    hotkeys: clone(HOTKEYS),
    aiModels: clone(AI_MODELS),
    aiBackend: { backend: "cuda", deviceName: "NVIDIA GeForce RTX 4070" },
  };

  const listeners = new Map<EventName, Set<(p: never) => void>>();
  const dropListeners = new Set<(e: FileDropEvent) => void>();
  const dispatchDrop = (e: FileDropEvent) => dropListeners.forEach((h) => h(e));
  const timers = new Set<ReturnType<typeof setInterval>>();
  const playing = new Map<string, ReturnType<typeof setInterval>>();
  const calls: MockBackend["calls"] = [];
  let previewing = false;
  let importCounter = 0;
  // MyInstants plays accepted but still "downloading" (see `PlaybackGate` in src-tauri/src/state.rs).
  const downloading = new Map<string, ReturnType<typeof setTimeout>>();
  // Like the app: the number of the page loaded now (bumped on every page load).
  let page = 1;
  let hotkeyStops = 0;

  function emit<E extends EventName>(event: E, payload: Events[E]) {
    listeners.get(event)?.forEach((h) => (h as (p: Events[E]) => void)(clone(payload)));
  }

  if (meters) {
    let t = 0;
    const id = setInterval(() => {
      t += 1;
      const speaking = Math.sin(t / 9) > -0.2;
      const base = speaking ? -18 + Math.sin(t / 2.3) * 8 + Math.random() * 6 : -58 + Math.random() * 6;
      const out = state.settings.voiceEnabled ? base + 2 : -90;
      emit("engine", { type: "meter", inputDb: base, outputDb: out });
    }, 70);
    timers.add(id);
  }

  /** A play still downloading never starts; like the app, the UI hears it ended. */
  function cancelDownload(id: string) {
    const timer = downloading.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    downloading.delete(id);
    emit("engine", { type: "soundEnded", id });
  }

  function stop(id: string) {
    const timer = playing.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      playing.delete(id);
      emit("engine", { type: "soundEnded", id });
    }
  }

  function play(id: string) {
    const sound = state.sounds.find((x) => x.id === id);
    if (!sound) throw new Error(`Son introuvable : ${id}`);
    playFor(id, sound);
  }

  function playFor(id: string, sound: { durationMs: number; loop: boolean }) {
    stop(id);
    let pos = 0;
    const step = 100;
    const timer = setInterval(() => {
      pos += step;
      if (pos >= sound.durationMs) {
        if (sound.loop) pos = 0;
        else return stop(id);
      }
      emit("engine", { type: "soundProgress", id, positionMs: pos, durationMs: sound.durationMs });
    }, step);
    playing.set(id, timer);
    emit("engine", { type: "soundProgress", id, positionMs: 0, durationMs: sound.durationMs });
  }

  function myinstants(query: string | null, page: number): SearchPage {
    if (options.myinstantsOffline) throw new Error("MyInstants est injoignable (pas de connexion internet ?)");
    const pool = query
      ? MYINSTANTS_TITLES.filter((t) => slug(t).includes(slug(query)))
      : MYINSTANTS_TITLES;
    // Trending repeats the pool with suffixes to emulate a long catalogue (5 pages).
    const total = query ? pool.length : PAGE_SIZE * 5;
    const start = (page - 1) * PAGE_SIZE;
    const sounds: RemoteSound[] = [];
    for (let i = start; i < Math.min(start + PAGE_SIZE, total); i++) {
      const title = pool[i % pool.length] ?? "Son";
      sounds.push(remote(i >= pool.length ? `${title} (remix ${Math.floor(i / pool.length)})` : title, i));
    }
    return { sounds, hasMore: start + PAGE_SIZE < total };
  }

  function setHotkey(action: HotkeyAction, accelerator: string | null) {
    state.hotkeys = state.hotkeys.filter((h) => !sameAction(h.action, action) && h.accelerator !== accelerator);
    if (accelerator) state.hotkeys.push({ action, accelerator });
    for (const s of state.sounds) {
      s.hotkey = state.hotkeys.find((h) => h.action.type === "sound" && h.action.id === s.id)?.accelerator ?? null;
    }
  }

  const devices = (): Devices => ({
    inputs: [
        { id: "in-mv7", name: "Shure MV7 (USB)", isDefault: true, isCable: false },
        { id: "in-realtek", name: "Microphone (Realtek High Definition Audio)", isDefault: false, isCable: false },
        { id: "in-cable-out", name: "CABLE Output (VB-Audio Virtual Cable)", isDefault: false, isCable: true },
      ],
      outputs: [
        { id: "out-arctis", name: "Casque (Arctis 7)", isDefault: true, isCable: false },
        { id: "out-realtek", name: "Haut-parleurs (Realtek High Definition Audio)", isDefault: false, isCable: false },
        ...(cableFound ? [{ id: "out-cable", name: "CABLE Input (VB-Audio Virtual Cable)", isDefault: false, isCable: true }] : []),
      ],
    });

  const handlers: { [K in CommandName]: (args: CommandArgs<K>) => CommandResult<K> | Promise<CommandResult<K>> } = {
    get_snapshot: () => state,
    list_devices: () => devices(),
    update_settings: ({ patch }) => {
      state.settings = { ...state.settings, ...patch };
      if (patch.devices) state.settings.devices = sanitizeDevices(patch.devices, devices());
      // Same limits as the Rust store.
      state.settings.aiParams = clampRvcParams(state.settings.aiParams);
      return state.settings;
    },
    set_voice_favorite: ({ id, favorite }) => {
      const ids = state.settings.favoriteVoiceIds.filter((x) => x !== id);
      state.settings.favoriteVoiceIds = favorite ? [...ids, id] : ids;
      return state.settings;
    },
    begin_page: () => ({ page, hotkeyStops }),
    set_active_voice: ({ id }) => {
      if (!state.voices.some((v) => v.id === id)) throw new Error(`Voix introuvable : ${id}`);
      state.settings.activeVoiceId = id;
      return state.settings;
    },
    save_voice: ({ voice }) => {
      const existing = state.voices.findIndex((v) => v.id === voice.id);
      if (existing >= 0 && state.voices[existing]?.builtin) throw new Error("Les voix intégrées ne sont pas modifiables : duplique-la.");
      if (!voice.name.trim()) throw new Error("Le nom de la voix est obligatoire.");
      const saved: VoicePreset = {
        ...voice,
        id: existing >= 0 ? voice.id : `custom-${slug(voice.name) || "voix"}-${Date.now().toString(36)}`,
        category: voice.aiModelId ? "ai" : "custom",
        builtin: false,
      };
      if (existing >= 0) state.voices[existing] = saved;
      else state.voices.push(saved);
      return saved;
    },
    delete_voice: ({ id }) => {
      const v = state.voices.find((x) => x.id === id);
      if (!v) throw new Error(`Voix introuvable : ${id}`);
      if (v.builtin) throw new Error("Les voix intégrées ne peuvent pas être supprimées.");
      state.voices = state.voices.filter((x) => x.id !== id);
      state.hotkeys = state.hotkeys.filter((h) => !(h.action.type === "voice" && h.action.id === id));
      if (state.settings.activeVoiceId === id) state.settings.activeVoiceId = "villager";
      return null;
    },
    preview_effects: ({ effects }) => {
      previewing = effects !== null;
      void previewing;
      return null;
    },
    import_sounds: ({ paths }) => {
      const bad = paths.find((x) => !/\.(mp3|wav|ogg|flac)$/i.test(x));
      if (bad) throw new Error(`Format non pris en charge : ${baseName(bad)} (mp3, wav, ogg ou flac)`);
      const added = paths.map((path): Sound => ({
        id: `snd-import-${++importCounter}`,
        name: baseName(path),
        category: null,
        favorite: false,
        volume: 0.8,
        loop: false,
        hotkey: null,
        durationMs: 1500 + ((importCounter * 1337) % 6000),
        source: "local",
        sourceUrl: null,
        color: null,
      }));
      state.sounds.push(...added);
      return added;
    },
    update_sound: ({ sound }) => {
      const i = state.sounds.findIndex((x) => x.id === sound.id);
      if (i < 0) throw new Error(`Son introuvable : ${sound.id}`);
      // Same rule as `sound_color` in the Rust store: trimmed, #rrggbb, lowercased.
      const trimmed = sound.color?.trim().toLowerCase() ?? null;
      const color = trimmed && /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : null;
      const next = { ...sound, color, volume: Math.min(1, Math.max(0, sound.volume)) };
      state.sounds[i] = next;
      // Same rule as the Rust store: hotkey is ignored here, set_hotkey owns bindings.
      next.hotkey = state.hotkeys.find((h) => sameAction(h.action, { type: "sound", id: sound.id }))?.accelerator ?? null;
      return state.sounds[i] as Sound;
    },
    delete_sound: ({ id }) => {
      stop(id);
      state.sounds = state.sounds.filter((x) => x.id !== id);
      state.hotkeys = state.hotkeys.filter((h) => !(h.action.type === "sound" && h.action.id === id));
      return null;
    },
    // Like the app, sound commands of a page since reloaded are ignored.
    play_sound: ({ id, page: from, stops }) => {
      if (from !== page) return null;
      // Like the app: clicked before the "stop all" shortcut ran, it just ends.
      if (stops < hotkeyStops) emit("engine", { type: "soundEnded", id });
      else play(id);
      return null;
    },
    stop_sound: ({ id, page: from }) => {
      if (from !== page) return null;
      cancelDownload(id);
      stop(id);
      return null;
    },
    stop_all_sounds: ({ page: from }) => {
      if (from !== page) return null;
      [...downloading.keys()].forEach(cancelDownload);
      [...playing.keys()].forEach(stop);
      return null;
    },
    myinstants_trending: ({ page }) => myinstants(null, page),
    myinstants_search: ({ query, page }) => myinstants(query, page),
    myinstants_play: ({ sound, replace, page: from, stops }) => {
      if (from !== page) throw new Error("page rechargée : relance le son");
      if (stops < hotkeyStops) {
        const id = `myinstants:${sound.mp3Url}#cancelled-${++remotePlays}`;
        emit("engine", { type: "soundEnded", id });
        return id;
      }
      if (replace) {
        cancelDownload(replace);
        stop(replace);
      }
      const id = `myinstants:${sound.mp3Url}#${++remotePlays}`;
      // Like the app: the id comes back at once, the sound starts once downloaded.
      const start = () => {
        downloading.delete(id);
        if (options.myinstantsOffline) {
          emit("engine", { type: "soundEnded", id });
          emit("sound-failed", { id, message: "MyInstants est injoignable (pas de connexion internet ?)" });
        } else playFor(id, { durationMs: 1500, loop: false });
      };
      if (options.myinstantsOffline || remoteDownloadMs > 0) downloading.set(id, setTimeout(start, remoteDownloadMs));
      else start();
      return id;
    },
    myinstants_add: ({ sound, category }) => {
      const added: Sound = {
        id: `snd-mi-${++importCounter}`,
        name: sound.title,
        category,
        favorite: false,
        volume: 0.8,
        loop: false,
        hotkey: null,
        durationMs: 2000,
        source: "myinstants",
        sourceUrl: sound.pageUrl,
        color: null,
      };
      state.sounds.push(added);
      return added;
    },
    set_hotkey: ({ action, accelerator }) => {
      setHotkey(action, accelerator);
      return state.hotkeys;
    },
    import_ai_model: ({ pthPath, indexPath, name }) =>
      new Promise((resolve, reject) => {
        if (!/\.pth$/i.test(pthPath)) return reject(new Error("Le modèle doit être un fichier .pth (RVC v2)."));
        if (/corrompu/i.test(pthPath)) {
          setTimeout(() => reject(new Error("Conversion impossible : le fichier .pth est corrompu ou n'est pas un modèle RVC v2.")), aiImportStepMs * 3);
          return;
        }
        let progress = 0;
        const timer = setInterval(() => {
          progress = Math.min(1, progress + 0.1);
          emit("ai-import-progress", { progress });
          if (progress >= 1) {
            clearInterval(timer);
            timers.delete(timer);
            const id = `ai-${slug(name) || "modele"}-${++importCounter}`;
            const meta = { id, name, modelSampleRate: 40000, hasIndex: indexPath !== null, builtin: false, license: null };
            state.aiModels.push(meta);
            state.voices.push({
              id: `voice-${id}`, name, description: "IA · RVC", icon: "mic", color: "#7fe7ff", category: "ai",
              effects: [], aiModelId: id, builtin: false,
            });
            resolve(meta);
          }
        }, aiImportStepMs);
        timers.add(timer);
      }),
    open_logs_folder: () => null,
    log_client_error: () => null,
    delete_ai_model: ({ id }) => {
      const m = state.aiModels.find((x) => x.id === id);
      if (!m) throw new Error(`Modèle introuvable : ${id}`);
      if (m.builtin) throw new Error("Les modèles fournis ne peuvent pas être supprimés.");
      state.aiModels = state.aiModels.filter((x) => x.id !== id);
      const removed = new Set(state.voices.filter((v) => v.aiModelId === id).map((v) => v.id));
      state.voices = state.voices.filter((v) => !removed.has(v.id));
      if (removed.has(state.settings.activeVoiceId)) state.settings.activeVoiceId = "villager";
      return null;
    },
  };

  const wait = () => new Promise((r) => setTimeout(r, latencyMs));

  return {
    calls,
    async invoke<K extends CommandName>(cmd: K, args: CommandArgs<K>): Promise<CommandResult<K>> {
      calls.push({ cmd, args: clone(args) });
      if (latencyMs > 0) await wait();
      const handler = handlers[cmd] as (a: CommandArgs<K>) => CommandResult<K> | Promise<CommandResult<K>>;
      return clone(await handler(clone(args)));
    },
    async listen<E extends EventName>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      const h = handler as (p: never) => void;
      set.add(h);
      return () => set.delete(h);
    },
    async pickFiles({ extensions, multiple }) {
      const ext = extensions[0] ?? "mp3";
      if (ext === "pth") return ["C:\\Users\\moi\\Modèles\\dark-vador.pth"];
      if (ext === "index") return ["C:\\Users\\moi\\Modèles\\dark-vador.index"];
      const files = ["Klaxon.mp3", "Rire diabolique.wav", "Gong.ogg"].map((f) => `C:\\Users\\moi\\Sons\\${f}`);
      return multiple ? files : files.slice(0, 1);
    },
    async onFileDrop(handler) {
      dropListeners.add(handler);
      return () => dropListeners.delete(handler);
    },
    simulateExternalChange(mutate) {
      mutate(state);
      emit("snapshot-changed", state);
    },
    simulateDeviceLoss(message) {
      state.status = { ...state.status, running: false, lastError: message, restarting: true, revision: state.status.revision + 1 };
      emit("engine", { type: "deviceError", message });
    },
    simulateHotkeyStopAll() {
      hotkeyStops += 1;
      [...downloading.keys()].forEach(cancelDownload);
      [...playing.keys()].forEach(stop);
      emit("sounds-stopped", hotkeyStops);
    },
    simulatePageLoad() {
      page += 1;
      [...downloading.keys()].forEach(cancelDownload);
      [...playing.keys()].forEach(stop);
    },
    simulateSoundEnded(id) {
      emit("engine", { type: "soundEnded", id });
    },
    simulateSoundFailed(id, message) {
      emit("engine", { type: "soundEnded", id });
      emit("sound-failed", { id, message });
    },
    simulateRecovery() {
      state.status = { ...state.status, running: true, lastError: null, restarting: false, revision: state.status.revision + 1 };
      emit("engine", { type: "recovered", message: "Son rétabli." });
    },
    simulateRetryFailure(message) {
      state.status = { ...state.status, running: false, lastError: message, restarting: true, revision: state.status.revision + 1 };
      emit("engine", { type: "statusChanged" });
    },
    simulateFallback(inputName) {
      state.status = { ...state.status, running: true, fallback: true, inputName, revision: state.status.revision + 1 };
      emit("engine", { type: "statusChanged" });
    },
    updates: {
      currentVersion: async () => MOCK_APP_VERSION,
      async check() {
        checks++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (checkGate) await checkGate;
          await wait();
        } finally {
          inFlight--;
        }
        const update = published;
        if (!update) return null;
        let released = false;
        const available: AvailableUpdate = {
          version: update.version,
          async install(onProgress) {
            // Like the Tauri handle: unusable once released.
            if (released) throw new Error("ressource de mise à jour fermée");
            const total = 40_000_000;
            for (let step = 1; step <= 4; step++) {
              await new Promise((r) => setTimeout(r, update.stepMs ?? 0));
              onProgress({ downloaded: (total / 4) * step, total, finished: step === 4 });
            }
            if (installGate) await installGate;
            if (update.failWith) throw new Error(update.failWith);
            hasRestarted = true;
          },
          async release() {
            released = true;
            releasedCount++;
          },
        };
        return available;
      },
    },
    setUpdate(update) {
      published = update;
    },
    updateChecks: () => checks,
    maxConcurrentChecks: () => maxInFlight,
    releasedUpdates: () => releasedCount,
    holdUpdateChecks() {
      let open = () => {};
      checkGate = new Promise<void>((r) => (open = r));
      return () => {
        checkGate = null;
        open();
      };
    },
    holdInstalls() {
      let open = () => {};
      installGate = new Promise<void>((r) => (open = r));
      return () => {
        installGate = null;
        open();
      };
    },
    restarted: () => hasRestarted,
    hasDropListener() {
      return dropListeners.size > 0;
    },
    simulateDrop(paths) {
      dispatchDrop({ type: "over" });
      dispatchDrop({ type: "drop", paths });
    },
    simulateDragEvent: dispatchDrop,
    dispose() {
      timers.forEach(clearInterval);
      downloading.forEach(clearTimeout);
      downloading.clear();
      playing.forEach(clearInterval);
      timers.clear();
      playing.clear();
    },
  };
}
