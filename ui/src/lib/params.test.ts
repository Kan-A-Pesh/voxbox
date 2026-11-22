import { describe, expect, it } from "vitest";
import type { ParamDescriptor } from "../ipc/contract";
import { EFFECT_CATALOG } from "../ipc/mockData";
import { BUILTIN_PRESETS } from "../ipc/generated/presets";
import { clampParam, formatParam, normalizeEffect } from "./params";

const semis: ParamDescriptor = { key: "semitones", label: "Demi-tons", min: -12, max: 12, step: 0.5, default: 0, unit: "dt" };
const cutoff: ParamDescriptor = { key: "cutoff", label: "Coupure", min: 200, max: 12000, step: 10, default: 3000, unit: "Hz" };

describe("editor param clamping", () => {
  it("clamps to [min, max]", () => {
    expect(clampParam(40, semis)).toBe(12);
    expect(clampParam(-99, semis)).toBe(-12);
    expect(clampParam(0, cutoff)).toBe(200);
  });

  it("snaps to the step grid without float noise", () => {
    expect(clampParam(3.26, semis)).toBe(3.5);
    expect(clampParam(3.24, semis)).toBe(3);
    expect(clampParam(1234, cutoff)).toBe(1230);
    expect(clampParam(0.1 + 0.2, { ...semis, step: 0.1 })).toBe(0.3);
  });

  it("falls back to the default for NaN / Infinity", () => {
    expect(clampParam(Number.NaN, cutoff)).toBe(3000);
    expect(clampParam(Number.POSITIVE_INFINITY, cutoff)).toBe(3000);
  });

  it("formats with the step precision and unit", () => {
    expect(formatParam(-5, semis)).toBe("-5.0 dt");
    expect(formatParam(1230, cutoff)).toBe("1230 Hz");
  });

  it("keeps every real preset value and fills the params a preset omits with catalog defaults", () => {
    for (const v of BUILTIN_PRESETS) {
      for (const fx of v.effects) {
        const d = EFFECT_CATALOG.find((x) => x.kind === fx.kind);
        const n = normalizeEffect(fx, EFFECT_CATALOG);
        for (const p of d?.params ?? []) {
          const given = fx.params[p.key];
          if (given === undefined) expect(n.params[p.key], `${v.id}:${fx.kind}.${p.key}`).toBe(p.default);
          else expect(n.params[p.key], `${v.id}:${fx.kind}.${p.key}`).toBe(given);
        }
      }
    }
  });

  it("normalizes presets: fills missing params, clamps out-of-range ones, drops unknown keys", () => {
    const echo = EFFECT_CATALOG.find((d) => d.kind === "echo");
    if (!echo) throw new Error("echo missing from the real catalog");
    const e = normalizeEffect({ kind: "echo", enabled: true, params: { delayMs: 99999, junk: 1 } }, EFFECT_CATALOG);
    const delay = echo.params.find((p) => p.key === "delayMs");
    expect(e.params.delayMs).toBe(delay?.max);
    expect(e.params).not.toHaveProperty("junk");
    for (const p of echo.params.filter((x) => x.key !== "delayMs")) expect(e.params[p.key]).toBe(p.default);
    expect(Object.keys(e.params).sort()).toEqual(echo.params.map((p) => p.key).sort());
  });
});

describe("formatParam with off-grid preset values", () => {
  it("does not round a preset value to the step for display", () => {
    const q: ParamDescriptor = { key: "q", label: "Q", min: 0.1, max: 10, step: 0.1, default: 0.7, unit: "" };
    expect(formatParam(0.75, q)).toBe("0.75");
    expect(formatParam(0.8, q)).toBe("0.8");
  });
});
