// Realistic fixture data for the in-browser mock backend (dev, screenshots, tests).
import { EFFECT_CATALOG } from "./generated/catalog";
import { BUILTIN_PRESETS } from "./generated/presets";
import type {
  AiModelMeta, AppSettings, EffectKind, EffectSpec, HotkeyBinding,
  Sound, VoicePreset,
} from "./contract";

// Generated from the real Rust presets/catalog (crates/voxbox-dsp/examples/dump_presets.rs);
// a voxbox-dsp test fails if they drift.
export { EFFECT_CATALOG };

export function defaultEffect(kind: EffectKind): EffectSpec {
  const d = EFFECT_CATALOG.find((e) => e.kind === kind);
  return {
    kind,
    enabled: true,
    params: Object.fromEntries((d?.params ?? []).map((x) => [x.key, x.default])),
  };
}

function fx(kind: EffectKind, params: Record<string, number> = {}): EffectSpec {
  const base = defaultEffect(kind);
  return { ...base, params: { ...base.params, ...params } };
}

export const BUILTIN_VOICES: VoicePreset[] = BUILTIN_PRESETS;

// Same candidates as converter/bundled_voices.json (VCTK speakers, Apache-2.0 models).
export const AI_MODELS: AiModelMeta[] = [
  { id: "vctk-p231", name: "Voix féminine (VCTK p231)", modelSampleRate: 40000, hasIndex: true, builtin: true, license: "Modèle Apache-2.0 · données VCTK CC-BY 4.0 (Yamagishi, Veaux, MacDonald)" },
  { id: "vctk-p226", name: "Voix masculine (VCTK p226)", modelSampleRate: 40000, hasIndex: true, builtin: true, license: "Modèle Apache-2.0 · données VCTK CC-BY 4.0 (Yamagishi, Veaux, MacDonald)" },
];

export const AI_VOICES: VoicePreset[] = AI_MODELS.map((m) => ({
  id: `ai-${m.id}`, name: m.name, description: "IA · RVC", icon: "mic", color: "#7fe7ff",
  category: "ai" as const, effects: [], aiModelId: m.id, builtin: true,
}));

export const CUSTOM_VOICES: VoicePreset[] = [
  { id: "custom-dark-lord", name: "Seigneur noir", description: "Ma voix · grave + écho", icon: "wrench", color: "#ff5d5d", category: "custom", builtin: false, aiModelId: null,
    effects: [fx("pitchShift", { semitones: -5 }), fx("echo", { delayMs: 180, feedback: 0.2, mix: 0.2 }), { ...fx("distortion", { drive: 4 }), enabled: false }] },
];

const s = (id: string, name: string, category: string | null, durationMs: number, extra: Partial<Sound> = {}): Sound => ({
  id, name, category, durationMs, favorite: false, volume: 0.8, loop: false, hotkey: null, source: "local", sourceUrl: null, ...extra,
});

export const SOUNDS: Sound[] = [
  s("snd-airhorn", "Corne de brume", "Mèmes", 2400, { favorite: true, hotkey: "Numpad1" }),
  s("snd-bruh", "Bruh", "Mèmes", 900, { favorite: true, hotkey: "Numpad2" }),
  s("snd-vine-boom", "Vine boom", "Mèmes", 1100, { hotkey: "Numpad3", source: "myinstants", sourceUrl: "https://www.myinstants.com/fr/instant/vine-boom/" }),
  s("snd-sad-trombone", "Trombone triste", "Mèmes", 3800),
  s("snd-oof", "Oof", "Mèmes", 600),
  s("snd-applause", "Applaudissements", "Réactions", 5200, { favorite: true }),
  s("snd-laugh", "Rires enregistrés", "Réactions", 4100, { hotkey: "Numpad4" }),
  s("snd-wow", "Wow", "Réactions", 1300),
  s("snd-crickets", "Criquets", "Réactions", 6000, { loop: true }),
  s("snd-drumroll", "Roulement de tambour", "Réactions", 4500),
  s("snd-rain", "Pluie", "Ambiances", 30000, { loop: true, volume: 0.4 }),
  s("snd-tavern", "Taverne", "Ambiances", 42000, { loop: true, volume: 0.35 }),
  s("snd-elevator", "Musique d'ascenseur", "Musique", 28000, { loop: true, volume: 0.5 }),
  s("snd-victory", "Fanfare de victoire", "Musique", 6500, { favorite: true, hotkey: "Ctrl+Shift+V" }),
  s("snd-suspense", "Suspense", "Musique", 9000),
  s("snd-door", "Porte qui grince", null, 2100),
];

export const HOTKEYS: HotkeyBinding[] = [
  ...BUILTIN_VOICES.slice(0, 9).map((v, i) => ({ action: { type: "voice" as const, id: v.id }, accelerator: `Ctrl+Alt+${i + 1}` })),
  { action: { type: "voice", id: "ai-vctk-p231" }, accelerator: "Ctrl+Alt+0" },
  ...SOUNDS.filter((x) => x.hotkey).map((x) => ({ action: { type: "sound" as const, id: x.id }, accelerator: x.hotkey as string })),
  { action: { type: "toggleVoice" }, accelerator: "Ctrl+Alt+V" },
  { action: { type: "toggleMonitor" }, accelerator: "Ctrl+Alt+M" },
  { action: { type: "pushToTalk" }, accelerator: "MouseX1" },
  { action: { type: "stopAllSounds" }, accelerator: "Ctrl+Alt+S" },
];

export const SETTINGS: AppSettings = {
  devices: { input: null, cable: null, monitor: null },
  voiceEnabled: true,
  activeVoiceId: "villager",
  monitor: true,
  noiseSuppression: true,
  pttMode: false,
  soundMicVolume: 0.8,
  soundMonitorVolume: 0.5,
  aiParams: { pitchSemitones: 0, indexRate: 0.75, blockMs: 160, crossfadeMs: 40 },
  startMinimized: false,
};

export const MYINSTANTS_TITLES = [
  "Vine boom", "Bruh", "Sad violin", "Here we go again", "Windows XP erreur", "Directed by Robert B. Weide",
  "Oh my god wow", "Emotional damage", "Coffin dance", "Mario jump", "Tuturu", "Metal gear alert", 
  "Taco Bell bong", "Discord notification", "Among us role reveal", "Nope", "Bonk", "Wilhelm scream", "Ça va bien se passer",
  "C'est pas faux", "Oh non pas ça", "Kaamelott – c'est pas faux", "Rire de Jacquouille", "OSS 117 – ça c'est fait",
  "Héhéhé", "Bip bip", "Goofy yell", "Censure bip", "Cri de chèvre", "Ding ding ding", "Roblox oof", "Cartoon slip",
  "Dramatic chipmunk", "Minecraft villager", "Hello there", "Nani?!", "Yeet", "Tadaaa", "Ba dum tss", "John Cena",
  "Run vine", "Mission failed", "Sheesh", "Gnome woo", "Bababooey", "FBI open up", "Cash register",
  "Ascenseur – ding", "Klaxon de clown", "Corne de brume", "Batterie roulement", "Trompette fail", "Applaudissements",
  "Rires de sitcom", "Huée", "Criquets", "Duel western", "Chat qui miaule", "Bisou", "Explosion",
];
