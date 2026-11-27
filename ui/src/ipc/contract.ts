// IPC contract between the UI and the Rust backend (src-tauri/src/commands.rs).
// Source of truth for both sides: keep field names camelCase and in sync with the
// serde structs in crates/voxbox-dsp, voxbox-engine, voxbox-rvc, voxbox-myinstants
// and src-tauri.

// ---- voxbox-dsp ---------------------------------------------------------------

export type EffectKind =
  | "pitchShift" | "formantShift" | "gain" | "lowPass" | "highPass" | "bandPass"
  | "distortion" | "bitcrush" | "ringMod" | "tremolo" | "vibrato" | "echo"
  | "reverb" | "chorus" | "robotize" | "whisper" | "noiseGate" | "compressor";

export interface EffectSpec {
  kind: EffectKind;
  params: Record<string, number>;
  enabled: boolean;
}

export type VoiceCategory = "fun" | "effects" | "custom" | "ai";

export interface VoicePreset {
  id: string;
  name: string;
  description: string;
  /** Pixel icon name (see ui pixel icon set). */
  icon: string;
  /** #rrggbb */
  color: string;
  category: VoiceCategory;
  effects: EffectSpec[];
  aiModelId: string | null;
  builtin: boolean;
}

export interface ParamDescriptor {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: string;
}

export interface EffectDescriptor {
  kind: EffectKind;
  label: string;
  description: string;
  params: ParamDescriptor[];
}

// ---- voxbox-engine ------------------------------------------------------------

export interface DeviceInfo { id: string; name: string; isDefault: boolean; isCable: boolean }
export interface Devices { inputs: DeviceInfo[]; outputs: DeviceInfo[] }
/** null = system default (input/monitor) or auto-detected CABLE Input (cable). */
export interface DeviceSelection { input: string | null; cable: string | null; monitor: string | null }

export interface EngineStatus {
  running: boolean;
  inputName: string | null;
  cableName: string | null;
  monitorName: string | null;
  cableFound: boolean;
  latencyMs: number;
  /** Why the engine is stopped (device named). Null while sound works. It retries on its own. */
  lastError: string | null;
  /** True while the engine retries on its own (no devices open). */
  restarting: boolean;
  /** Running on the system defaults while the saved devices are missing (switches back by itself). */
  fallback: boolean;
  /** Grows with every status change: an older read never replaces a newer one. */
  revision: number;
}

export type EngineEvent =
  | { type: "meter"; inputDb: number; outputDb: number }
  | { type: "soundProgress"; id: string; positionMs: number; durationMs: number }
  | { type: "soundEnded"; id: string }
  | { type: "deviceError"; message: string }
  /** Sound is back after an automatic restart. */
  | { type: "recovered"; message: string }
  /** Status changed quietly (e.g. a retry identified the failing device): re-read it, no notification. */
  | { type: "statusChanged" };

// ---- voxbox-rvc ---------------------------------------------------------------

export type AiBackend = "cuda" | "directMl" | "cpu";
export interface BackendInfo { backend: AiBackend; deviceName: string }
export interface AiModelMeta {
  id: string;
  name: string;
  modelSampleRate: number;
  hasIndex: boolean;
  builtin: boolean;
  license: string | null;
}
export interface RvcParams { pitchSemitones: number; indexRate: number; blockMs: number; crossfadeMs: number }

// ---- voxbox-myinstants --------------------------------------------------------

export interface RemoteSound { title: string; mp3Url: string; pageUrl: string }
export interface SearchPage { sounds: RemoteSound[]; hasMore: boolean }

// ---- voxbox-voicemodels -------------------------------------------------------

/** One RVC model listed on voice-models.com. `size` is the site's label ("88.59 MB"), possibly empty. */
export interface RemoteModel { title: string; size: string; downloadUrl: string; pageUrl: string }
export interface ModelPage { models: RemoteModel[]; hasMore: boolean }

// ---- src-tauri ----------------------------------------------------------------

export interface Sound {
  id: string;
  name: string;
  category: string | null;
  favorite: boolean;
  /** 0..1 */
  volume: number;
  loop: boolean;
  hotkey: string | null;
  durationMs: number;
  source: "local" | "myinstants";
  sourceUrl: string | null;
  /** `#rrggbb` picked by the user, or null for the bank's default look. */
  color: string | null;
}

export type HotkeyAction =
  | { type: "voice"; id: string }
  | { type: "sound"; id: string }
  | { type: "toggleVoice" }
  | { type: "toggleMonitor" }
  | { type: "pushToTalk" }
  | { type: "stopAllSounds" };

/** Accelerator syntax: "Ctrl+Alt+1", "F13", "Shift+F2", "Numpad5", "MouseX1". */
export interface HotkeyBinding { action: HotkeyAction; accelerator: string }

export interface AppSettings {
  devices: DeviceSelection;
  voiceEnabled: boolean;
  activeVoiceId: string;
  monitor: boolean;
  noiseSuppression: boolean;
  pttMode: boolean;
  /** 0..1, soundboard level sent to the virtual mic (others hear). */
  soundMicVolume: number;
  /** 0..1, soundboard level in the headset (you hear). */
  soundMonitorVolume: number;
  aiParams: RvcParams;
  startMinimized: boolean;
  /** Starred voices (any kind), listed first. */
  favoriteVoiceIds: string[];
}

export interface Snapshot {
  settings: AppSettings;
  status: EngineStatus;
  voices: VoicePreset[];
  effectCatalog: EffectDescriptor[];
  sounds: Sound[];
  hotkeys: HotkeyBinding[];
  aiModels: AiModelMeta[];
  aiBackend: BackendInfo;
}

/** Tauri commands: name -> [args, result]. Args are passed as an object. */
export interface Commands {
  get_snapshot: [Record<string, never>, Snapshot];
  list_devices: [Record<string, never>, Devices];
  update_settings: [{ patch: Partial<AppSettings> }, AppSettings];
  set_active_voice: [{ id: string }, AppSettings];
  /** Adds or removes one favorite voice in the saved list. */
  set_voice_favorite: [{ id: string; favorite: boolean }, AppSettings];
  /** This page's number for the sound commands (the app moves to a new number, and stops the sounds, on every page load),
   * and the "stop all" shortcut's count so far. */
  begin_page: [Record<string, never>, { page: number; hotkeyStops: number }];
  /** Creates (empty/unknown id) or updates a custom voice. */
  save_voice: [{ voice: VoicePreset }, VoicePreset];
  delete_voice: [{ id: string }, null];
  /** Live editor preview: overrides the active voice until called with null. */
  preview_effects: [{ effects: EffectSpec[] | null }, null];
  import_sounds: [{ paths: string[] }, Sound[]];
  /** Saves name/category/favorite/volume/loop. `hotkey` is ignored: use set_hotkey. */
  update_sound: [{ sound: Sound }, Sound];
  delete_sound: [{ id: string }, null];
  // Sound commands: sent one at a time with this page's number (see lib/soundCommands.ts).
  /** Starts once decoded; a failure arrives as `sound-failed`. */
  /** `stops`: how many times the "stop all" shortcut had run when it was clicked (see `sounds-stopped`). */
  play_sound: [{ id: string; page: number; stops: number }, null];
  stop_sound: [{ id: string; page: number }, null];
  stop_all_sounds: [{ page: number }, null];
  myinstants_trending: [{ page: number }, SearchPage];
  myinstants_search: [{ query: string; page: number }, SearchPage];
  myinstants_add: [{ sound: RemoteSound; category: string | null }, Sound];
  /**
   * Plays a MyInstants sound without adding it: to everyone (mic + headset), or in the
   * headset only when `preview`. Returns the playback id at once (stop_sound,
   * soundProgress/Ended); the sound starts once downloaded, a failure arrives as
   * `sound-failed`. `replace`: a playback of this screen to stop first (switching mode).
   */
  myinstants_play: [{ sound: RemoteSound; preview: boolean; replace?: string | null; page: number; stops: number }, string];
  /** accelerator null removes the binding. Returns all bindings. */
  set_hotkey: [{ action: HotkeyAction; accelerator: string | null }, HotkeyBinding[]];
  /** Emits "ai-import-progress" { progress: 0..1 } while converting. Also creates the AI voice. */
  import_ai_model: [{ pthPath: string; indexPath: string | null; name: string }, AiModelMeta];
  delete_ai_model: [{ id: string }, null];
  /** Opens the folder holding voxbox.log in the file explorer. */
  open_logs_folder: [Record<string, never>, null];
  /** Writes an error the UI showed (or an uncaught one) to voxbox.log. */
  log_client_error: [{ context: string; message: string }, null];
  /** One page (25 models) of voice-models.com; an empty query lists the whole catalogue. */
  voicemodels_search: [{ query: string; page: number }, ModelPage];
  /**
   * Downloads the model zip, extracts its .pth and imports it like import_ai_model (the archive's
   * .index is not read: unsafe from an unknown source, so hasIndex is false).
   * Emits "voicemodels-progress" (download, then convert). Also creates the AI voice.
   */
  voicemodels_add: [{ url: string; name: string }, AiModelMeta];
}

/** Backend -> UI events. */
export interface Events {
  engine: EngineEvent;
  /** Pushed whenever state changes outside the UI (hotkeys, tray, device loss). */
  "snapshot-changed": Snapshot;
  "ai-import-progress": { progress: number };
  /** A play the app accepted could not start (download or decoding failed); its `soundEnded` is sent too. */
  "sound-failed": { id: string; message: string };
  /** The "stop all" shortcut ran: how many times so far. A play clicked before it is refused (it just ends). */
  "sounds-stopped": number;
  "voicemodels-progress": { stage: "download" | "convert"; progress: number };
}
