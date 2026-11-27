import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend, type MockBackend } from "../ipc/mock";
import { beginSoundPage, sendSoundCommand } from "./soundCommands";

let backend: MockBackend;
afterEach(() => backend?.dispose());

describe("sound commands", () => {
  it("ask for the page again after a failed handshake, instead of failing forever", async () => {
    backend = createMockBackend({ meters: false });
    const invoke = backend.invoke.bind(backend);
    let failures = 1;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "begin_page" && failures-- > 0 ? Promise.reject(new Error("pont IPC indisponible")) : invoke(cmd as never, args as never)) as typeof backend.invoke);
    const stopAll = () => sendSoundCommand(backend, (page) => backend.invoke("stop_all_sounds", { page }));
    await expect(beginSoundPage(backend)).rejects.toThrow("pont IPC indisponible");
    // Never answered yet: a click is refused, not sent with a count read later.
    await expect(stopAll()).rejects.toThrow("se connecte encore");
    await beginSoundPage(backend);
    await expect(stopAll()).resolves.toBeNull();
  });

  it("listen to the shortcut's stops before asking the count, and listen again after a failure", async () => {
    backend = createMockBackend({ meters: false });
    const listen = backend.listen.bind(backend);
    const invoke = backend.invoke.bind(backend);
    const order: string[] = [];
    let attempts = 0;
    let release: () => void = () => {};
    vi.spyOn(backend, "listen").mockImplementation(((event: string, handler: never) => {
      if (event !== "sounds-stopped") return listen(event as never, handler);
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("écoute impossible"));
      return new Promise<void>((resolve) => (release = resolve)).then(() => {
        order.push("listening");
        return listen(event as never, handler);
      });
    }) as typeof backend.listen);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "begin_page") order.push("begin_page");
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await expect(beginSoundPage(backend)).rejects.toThrow("écoute impossible");
    const page = beginSoundPage(backend);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await page;
    expect(order).toEqual(["listening", "begin_page"]);
    // A shortcut press now reaches the next clicks.
    backend.simulateHotkeyStopAll();
    const stops = await sendSoundCommand(backend, async (_page, stops) => stops);
    expect(stops).toBe(1);
  });

  it("run one at a time, in the order they were asked", async () => {
    backend = createMockBackend({ meters: false });
    await beginSoundPage(backend);
    const order: string[] = [];
    let release: () => void = () => {};
    const first = sendSoundCommand(backend, () => new Promise<void>((resolve) => (release = resolve)).then(() => void order.push("first")));
    const second = sendSoundCommand(backend, async () => void order.push("second"));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});
