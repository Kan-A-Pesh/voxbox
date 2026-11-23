import { describe, expect, it, vi } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...args: unknown[]) => check(...args) }));

const { tauriBackend } = await import("./tauri");

describe("tauri updates.check", () => {
  it("rejects on « no valid release JSON »: the updater says it for any HTTP error too, so it is not « no update »", async () => {
    const notFound = "Could not fetch a valid release JSON from the remote";
    check.mockImplementation(() => Promise.reject(notFound));
    await expect(tauriBackend.updates.check()).rejects.toBe(notFound);
  });

  it("rejects on a transport error", async () => {
    check.mockImplementation(() => Promise.reject("error sending request for url (https://github.com/…)"));
    await expect(tauriBackend.updates.check()).rejects.toBe("error sending request for url (https://github.com/…)");
  });

  it("answers null when the published release is not newer, and wraps one that is", async () => {
    check.mockImplementation(() => Promise.resolve(null));
    await expect(tauriBackend.updates.check()).resolves.toBeNull();
    check.mockImplementation(() => Promise.resolve({ version: "0.1.42", close: vi.fn(() => Promise.resolve()) }));
    const update = await tauriBackend.updates.check();
    expect(update?.version).toBe("0.1.42");
    await update?.release();
  });
});
