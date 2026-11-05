// In-memory backend used when the UI runs outside Tauri (browser dev, screenshots, tests).
// It mirrors the contract semantics of src-tauri/src/commands.rs closely enough to drive every screen.
import type { Backend, CommandArgs, CommandName, CommandResult, EventName, FileDropEvent, Unlisten } from "./backend";
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
  /** Saved devices point to a USB headset that is no longer plugged in. */
  unpluggedHeadset?: boolean;
}

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
  /** Test hook: the engine stops after a device disappears (only an `engine` event, like the Rust runtime). */
  simulateDeviceLoss(message: string): void;
  /** Invocation log, oldest first. */
  calls: { cmd: CommandName; args: unknown }[];
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
  const { latencyMs = 0, meters = true, aiImportStepMs = 120 } = options;
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
  const timers = new Set<ReturnType<typeof setInterval>>();
  const playing = new Map<string, ReturnType<typeof setInterval>>();
  const calls: MockBackend["calls"] = [];
  let previewing = false;
  let importCounter = 0;

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
      }));
      state.sounds.push(...added);
      return added;
    },
    update_sound: ({ sound }) => {
      const i = state.sounds.findIndex((x) => x.id === sound.id);
      if (i < 0) throw new Error(`Son introuvable : ${sound.id}`);
      const next = { ...sound, volume: Math.min(1, Math.max(0, sound.volume)) };
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
    play_sound: ({ id }) => (play(id), null),
    stop_sound: ({ id }) => (stop(id), null),
    stop_all_sounds: () => {
      [...playing.keys()].forEach(stop);
      return null;
    },
    myinstants_trending: ({ page }) => myinstants(null, page),
    myinstants_search: ({ query, page }) => myinstants(query, page),
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
      state.status = { ...state.status, running: false };
      emit("engine", { type: "deviceError", message });
    },
    simulateDrop(paths) {
      dropListeners.forEach((h) => h({ type: "over" }));
      dropListeners.forEach((h) => h({ type: "drop", paths }));
    },
    dispose() {
      timers.forEach(clearInterval);
      playing.forEach(clearInterval);
      timers.clear();
      playing.clear();
    },
  };
}
