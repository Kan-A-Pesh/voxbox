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
}

export type EngineEvent =
  | { type: "meter"; inputDb: number; outputDb: number }
  | { type: "soundProgress"; id: string; positionMs: number; durationMs: number }
  | { type: "soundEnded"; id: string }
  | { type: "deviceError"; message: string };

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
  /** Creates (empty/unknown id) or updates a custom voice. */
  save_voice: [{ voice: VoicePreset }, VoicePreset];
  delete_voice: [{ id: string }, null];
  /** Live editor preview: overrides the active voice until called with null. */
  preview_effects: [{ effects: EffectSpec[] | null }, null];
  import_sounds: [{ paths: string[] }, Sound[]];
  /** Saves name/category/favorite/volume/loop. `hotkey` is ignored: use set_hotkey. */
  update_sound: [{ sound: Sound }, Sound];
  delete_sound: [{ id: string }, null];
  play_sound: [{ id: string }, null];
  stop_sound: [{ id: string }, null];
  stop_all_sounds: [Record<string, never>, null];
  myinstants_trending: [{ page: number }, SearchPage];
  myinstants_search: [{ query: string; page: number }, SearchPage];
  myinstants_add: [{ sound: RemoteSound; category: string | null }, Sound];
  /** accelerator null removes the binding. Returns all bindings. */
  set_hotkey: [{ action: HotkeyAction; accelerator: string | null }, HotkeyBinding[]];
  /** Emits "ai-import-progress" { progress: 0..1 } while converting. Also creates the AI voice. */
  import_ai_model: [{ pthPath: string; indexPath: string | null; name: string }, AiModelMeta];
  delete_ai_model: [{ id: string }, null];
}

/** Backend -> UI events. */
export interface Events {
  engine: EngineEvent;
  /** Pushed whenever state changes outside the UI (hotkeys, tray, device loss). */
  "snapshot-changed": Snapshot;
  "ai-import-progress": { progress: number };
}
