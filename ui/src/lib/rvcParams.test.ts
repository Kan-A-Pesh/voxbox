import { describe, expect, it } from "vitest";
import { clampRvcParams, maxCrossfadeMs } from "./rvcParams";

// Same cases as `ai_params_use_the_ui_limits` in src-tauri/src/store.rs.
describe("RVC params limits", () => {
  it("clamps every field into the range the engine accepts", () => {
    expect(clampRvcParams({ pitchSemitones: 30, indexRate: 2, blockMs: 40, crossfadeMs: 0 })).toEqual({
      pitchSemitones: 12, indexRate: 1, blockMs: 100, crossfadeMs: 10,
    });
    expect(clampRvcParams({ pitchSemitones: -30, indexRate: -1, blockMs: 5000, crossfadeMs: 900 })).toEqual({
      pitchSemitones: -12, indexRate: 0, blockMs: 1000, crossfadeMs: 200,
    });
  });

  it("snaps timings to 10 ms and keeps the crossfade within half a block", () => {
    expect(clampRvcParams({ pitchSemitones: 0, indexRate: 0.5, blockMs: 255, crossfadeMs: 127 })).toEqual({
      pitchSemitones: 0, indexRate: 0.5, blockMs: 250, crossfadeMs: 120,
    });
    expect(maxCrossfadeMs(100)).toBe(50);
    expect(maxCrossfadeMs(1000)).toBe(200);
  });
});
