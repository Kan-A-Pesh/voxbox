import type { RvcParams } from "../ipc/contract";

// Valid AI-voice settings. Same rules as `AppSettings::apply` in src-tauri/src/store.rs
// (the backend clamps with them, the RVC worker accepts anything inside them).
export const RVC_LIMITS = {
  pitchSemitones: { min: -12, max: 12, step: 1 },
  indexRate: { min: 0, max: 1, step: 0.05 },
  blockMs: { min: 100, max: 1000, step: 10 },
  crossfadeMs: { min: 10, step: 10 },
} as const;

/** Crossfade is at most half a block, and never more than 200 ms. */
export const maxCrossfadeMs = (blockMs: number) => Math.min(200, Math.floor(blockMs / 2 / 10) * 10);

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const snap10 = (v: number) => Math.floor(v / 10) * 10;

export function clampRvcParams(p: RvcParams): RvcParams {
  const blockMs = snap10(clamp(p.blockMs, RVC_LIMITS.blockMs.min, RVC_LIMITS.blockMs.max));
  return {
    pitchSemitones: clamp(p.pitchSemitones, RVC_LIMITS.pitchSemitones.min, RVC_LIMITS.pitchSemitones.max),
    indexRate: clamp(p.indexRate, RVC_LIMITS.indexRate.min, RVC_LIMITS.indexRate.max),
    blockMs,
    crossfadeMs: snap10(clamp(p.crossfadeMs, RVC_LIMITS.crossfadeMs.min, maxCrossfadeMs(blockMs))),
  };
}

export const sameRvcParams = (a: RvcParams, b: RvcParams) =>
  a.pitchSemitones === b.pitchSemitones && a.indexRate === b.indexRate && a.blockMs === b.blockMs && a.crossfadeMs === b.crossfadeMs;
