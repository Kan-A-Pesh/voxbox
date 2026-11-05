import { afterEach, describe, expect, it } from "vitest";
import type { Commands, EngineEvent } from "./contract";
import { createMockBackend, type MockBackend } from "./mock";
import { ICONS } from "../components/icons";
import { BUILTIN_PRESETS } from "./generated/presets";

const REQUIRED_ICONS = [
  "home", "bot", "flame", "rabbit", "mountain", "radio", "phone", "church", "alien", "ghost", "shield", "sparkles",
  "crown", "megaphone", "bubbles", "cave", "baby", "hourglass", "skull", "snowflake", "tv", "wave",
];

let backend: MockBackend;
const make = (o = {}) => (backend = createMockBackend({ meters: false, aiImportStepMs: 1, ...o }));
afterEach(() => backend?.dispose());

// Compile-time guard: adding a command to the contract without covering it here fails `tsc`.
const COVERED: Record<keyof Commands, true> = {
  get_snapshot: true, list_devices: true, update_settings: true, set_active_voice: true, save_voice: true,
  delete_voice: true, preview_effects: true, import_sounds: true, update_sound: true, delete_sound: true,
  play_sound: true, stop_sound: true, stop_all_sounds: true, myinstants_trending: true, myinstants_search: true,
  myinstants_add: true, set_hotkey: true, import_ai_model: true, delete_ai_model: true,
};

describe("mock backend honours the IPC contract", () => {
  it("covers every command", () => {
    expect(Object.keys(COVERED)).toHaveLength(19);
  });

  it("returns a complete snapshot with the 22 real presets, the 2 bundled AI voices and ~16 sounds", async () => {
    const snap = await make().invoke("get_snapshot", {});
    const builtin = snap.voices.filter((v) => v.builtin && !v.aiModelId);
    expect(builtin).toHaveLength(22);
    expect(builtin.map((v) => v.icon).sort()).toEqual([...REQUIRED_ICONS].sort());
    expect(builtin.map((v) => v.id)).toEqual(BUILTIN_PRESETS.map((v) => v.id));
    const ai = snap.voices.filter((v) => v.category === "ai");
    expect(ai.map((v) => v.aiModelId)).toEqual(["vctk-p231", "vctk-p226"]);
    expect(snap.aiModels.every((m) => m.builtin && m.license)).toBe(true);
    expect(snap.sounds.length).toBeGreaterThanOrEqual(16);
    expect(snap.voices.every((v) => v.icon in ICONS && /^#[0-9a-f]{6}$/i.test(v.color))).toBe(true);
    // Every effect of every preset references a catalog entry and only known params.
    for (const v of snap.voices) {
      for (const e of v.effects) {
        const d = snap.effectCatalog.find((x) => x.kind === e.kind);
        expect(d, `${v.id}:${e.kind}`).toBeDefined();
        // Presets may omit params (engine default applies), never invent one, never leave the range.
        for (const [key, value] of Object.entries(e.params)) {
          const p = d?.params.find((x) => x.key === key);
          expect(p, `${v.id}:${e.kind}.${key}`).toBeDefined();
          expect(value).toBeGreaterThanOrEqual(p?.min ?? Number.NaN);
          expect(value).toBeLessThanOrEqual(p?.max ?? Number.NaN);
        }
      }
    }
  });

  it("lists devices including the VB-Cable input", async () => {
    const devices = await make().invoke("list_devices", {});
    expect(devices.outputs.some((d) => d.isCable && d.name === "CABLE Input (VB-Audio Virtual Cable)")).toBe(true);
    const missing = await make({ cableMissing: true }).invoke("list_devices", {});
    expect(missing.outputs.some((d) => d.isCable)).toBe(false);
  });

  it("updates settings and the active voice, rejecting unknown ids", async () => {
    const b = make();
    expect((await b.invoke("update_settings", { patch: { monitor: false } })).monitor).toBe(false);
    expect((await b.invoke("set_active_voice", { id: "robot" })).activeVoiceId).toBe("robot");
    await expect(b.invoke("set_active_voice", { id: "nope" })).rejects.toThrow(/introuvable/);
  });

  it("creates, updates and deletes custom voices but protects built-ins", async () => {
    const b = make();
    const snap = await b.invoke("get_snapshot", {});
    const robot = snap.voices.find((v) => v.id === "robot");
    if (!robot) throw new Error("robot missing");
    await expect(b.invoke("save_voice", { voice: robot })).rejects.toThrow(/intégrées/);
    const created = await b.invoke("save_voice", { voice: { ...robot, id: "", name: "Mon robot", builtin: false } });
    expect(created.id).not.toBe("");
    expect(created.category).toBe("custom");
    const renamed = await b.invoke("save_voice", { voice: { ...created, name: "Robot 2" } });
    expect(renamed.id).toBe(created.id);
    expect(await b.invoke("delete_voice", { id: created.id })).toBeNull();
    await expect(b.invoke("delete_voice", { id: "robot" })).rejects.toThrow();
    expect(await b.invoke("preview_effects", { effects: robot.effects })).toBeNull();
    expect(await b.invoke("preview_effects", { effects: null })).toBeNull();
  });

  it("imports, edits, plays and deletes sounds with progress events", async () => {
    const b = make();
    const events: EngineEvent[] = [];
    await b.listen("engine", (e) => events.push(e));
    const added = await b.invoke("import_sounds", { paths: ["C:\\a\\Klaxon.mp3", "C:\\a\\Gong.flac"] });
    expect(added.map((s) => s.name)).toEqual(["Klaxon", "Gong"]);
    await expect(b.invoke("import_sounds", { paths: ["C:\\a\\doc.pdf"] })).rejects.toThrow(/Format/);
    const first = added[0];
    if (!first) throw new Error("no sound");
    const updated = await b.invoke("update_sound", { sound: { ...first, volume: 3, hotkey: "F13" } });
    expect(updated.volume).toBe(1);
    expect(updated.hotkey).toBeNull();
    await b.invoke("set_hotkey", { action: { type: "sound", id: first.id }, accelerator: "F13" });
    expect((await b.invoke("get_snapshot", {})).hotkeys).toContainEqual({ action: { type: "sound", id: first.id }, accelerator: "F13" });
    await b.invoke("play_sound", { id: first.id });
    expect(events).toContainEqual(expect.objectContaining({ type: "soundProgress", id: first.id, positionMs: 0 }));
    await b.invoke("stop_sound", { id: first.id });
    expect(events).toContainEqual({ type: "soundEnded", id: first.id });
    await b.invoke("play_sound", { id: first.id });
    await b.invoke("stop_all_sounds", {});
    expect(events.filter((e) => e.type === "soundEnded")).toHaveLength(2);
    await b.invoke("delete_sound", { id: first.id });
    expect((await b.invoke("get_snapshot", {})).sounds.some((s) => s.id === first.id)).toBe(false);
  });

  it("pages MyInstants trending and search, and fails when offline", async () => {
    const b = make();
    const p1 = await b.invoke("myinstants_trending", { page: 1 });
    expect(p1.sounds).toHaveLength(24);
    expect(p1.hasMore).toBe(true);
    const p5 = await b.invoke("myinstants_trending", { page: 5 });
    expect(p5.hasMore).toBe(false);
    const search = await b.invoke("myinstants_search", { query: "bruh", page: 1 });
    expect(search.sounds.every((s) => /bruh/i.test(s.title))).toBe(true);
    const first = p1.sounds[0];
    if (!first) throw new Error("empty page");
    const added = await b.invoke("myinstants_add", { sound: first, category: "Mèmes" });
    expect(added).toMatchObject({ source: "myinstants", sourceUrl: first.pageUrl, category: "Mèmes" });
    await expect(make({ myinstantsOffline: true }).invoke("myinstants_trending", { page: 1 })).rejects.toThrow(/injoignable/);
  });

  it("rebinds hotkeys, stealing an accelerator from its previous owner", async () => {
    const b = make();
    const all = await b.invoke("set_hotkey", { action: { type: "toggleVoice" }, accelerator: "Ctrl+Alt+1" });
    expect(all.filter((h) => h.accelerator === "Ctrl+Alt+1")).toEqual([{ action: { type: "toggleVoice" }, accelerator: "Ctrl+Alt+1" }]);
    const cleared = await b.invoke("set_hotkey", { action: { type: "toggleVoice" }, accelerator: null });
    expect(cleared.some((h) => h.action.type === "toggleVoice")).toBe(false);
  });

  it("only rebinds on a real hotkey change: a stale sound edit cannot steal an accelerator back", async () => {
    const b = make();
    const snap = await b.invoke("get_snapshot", {});
    const airhorn = snap.sounds.find((x) => x.id === "snd-airhorn");
    if (!airhorn) throw new Error("fixture");
    expect(airhorn.hotkey).toBe("Numpad1");
    await b.invoke("set_hotkey", { action: { type: "toggleMonitor" }, accelerator: "Numpad1" });
    const saved = await b.invoke("update_sound", { sound: { ...airhorn, favorite: !airhorn.favorite } });
    expect(saved.hotkey).toBeNull();
    const after = await b.invoke("get_snapshot", {});
    expect(after.hotkeys.filter((h) => h.accelerator === "Numpad1")).toEqual([{ action: { type: "toggleMonitor" }, accelerator: "Numpad1" }]);
  });

  it("imports an AI model with progress, creates its voice, and deletes it", async () => {
    const b = make();
    const progress: number[] = [];
    await b.listen("ai-import-progress", (p) => progress.push(p.progress));
    const meta = await b.invoke("import_ai_model", { pthPath: "C:\\m\\vador.pth", indexPath: null, name: "Vador" });
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBeGreaterThan(3);
    const snap = await b.invoke("get_snapshot", {});
    expect(snap.voices.some((v) => v.aiModelId === meta.id && v.category === "ai")).toBe(true);
    await b.invoke("delete_ai_model", { id: meta.id });
    expect((await b.invoke("get_snapshot", {})).voices.some((v) => v.aiModelId === meta.id)).toBe(false);
    await expect(b.invoke("import_ai_model", { pthPath: "C:\\m\\x.onnx", indexPath: null, name: "X" })).rejects.toThrow(/\.pth/);
    await expect(b.invoke("delete_ai_model", { id: "vctk-p231" })).rejects.toThrow();
  });

  it("pushes snapshot-changed for external changes", async () => {
    const b = make();
    let seen = "";
    await b.listen("snapshot-changed", (s) => (seen = s.settings.activeVoiceId));
    b.simulateExternalChange((s) => (s.settings.activeVoiceId = "alien"));
    expect(seen).toBe("alien");
  });
});
