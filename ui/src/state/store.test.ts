import { describe, expect, it } from "vitest";
import type { EngineStatus } from "../ipc/contract";
import { newerStatus } from "./store";

const status = (revision: number, running: boolean): EngineStatus => ({
  running,
  inputName: null,
  cableName: null,
  monitorName: null,
  cableFound: true,
  latencyMs: 18,
  lastError: running ? null : "Casque débranché",
  restarting: !running,
  fallback: false,
  revision,
});

describe("engine status reads that resolve out of order", () => {
  it("keeps the newest revision", () => {
    const recovered = status(7, true);
    const staleOutage = status(5, false);
    expect(newerStatus(recovered, staleOutage)).toBe(recovered);
    expect(newerStatus(staleOutage, recovered)).toBe(recovered);
  });

  it("accepts an equal revision (same status read twice)", () => {
    const a = status(3, true);
    const b = status(3, true);
    expect(newerStatus(a, b)).toBe(b);
  });
});
