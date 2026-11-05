import type { EffectDescriptor, EffectSpec, ParamDescriptor } from "../ipc/contract";

const decimals = (step: number) => {
  const s = String(step);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
};

/** Clamp into [min, max] and snap to the descriptor's step grid (anchored at min). */
export function clampParam(value: number, d: ParamDescriptor): number {
  if (!Number.isFinite(value)) return d.default;
  const clamped = Math.min(d.max, Math.max(d.min, value));
  if (d.step <= 0) return clamped;
  const snapped = d.min + Math.round((clamped - d.min) / d.step) * d.step;
  return Number(Math.min(d.max, snapped).toFixed(decimals(d.step)));
}

export function formatParam(value: number, d: ParamDescriptor): string {
  // Preset values may be finer than the step (0.75 on a 0.1 grid): show them as they are, up to 2 decimals.
  const v = value.toFixed(Math.min(2, Math.max(decimals(d.step), decimals(value))));
  return d.unit ? `${v} ${d.unit}` : v;
}

/**
 * Fill missing params with defaults and clamp the rest into range. No step snapping here:
 * a preset value off the slider grid (q = 0.75 with step 0.1) must survive a duplicate untouched.
 */
export function normalizeEffect(effect: EffectSpec, catalog: EffectDescriptor[]): EffectSpec {
  const d = catalog.find((x) => x.kind === effect.kind);
  if (!d) return effect;
  const params = Object.fromEntries(
    d.params.map((p) => {
      const v = effect.params[p.key];
      return [p.key, v === undefined || !Number.isFinite(v) ? p.default : Math.min(p.max, Math.max(p.min, v))];
    }),
  );
  return { ...effect, params };
}

export function newEffect(d: EffectDescriptor): EffectSpec {
  return { kind: d.kind, enabled: true, params: Object.fromEntries(d.params.map((p) => [p.key, p.default])) };
}
