import { describe, expect, it } from "vitest";
import { captureKey, captureMouse, type KeyLike } from "./accelerator";

const key = (code: string, mods: Partial<KeyLike> = {}, k = code): KeyLike => ({
  code, key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

describe("captureKey -> accelerator syntax of the contract", () => {
  it.each([
    [key("Digit1", { ctrlKey: true, altKey: true }, "&"), "Ctrl+Alt+1"], // AZERTY: physical key wins
    [key("F13"), "F13"],
    [key("F2", { shiftKey: true }), "Shift+F2"],
    [key("Numpad5", {}, "5"), "Numpad5"],
    [key("KeyV", { ctrlKey: true, altKey: true, shiftKey: true }, "v"), "Ctrl+Alt+Shift+V"],
    [key("Space", { ctrlKey: true }, " "), "Ctrl+Space"],
    [key("ArrowUp", { altKey: true }), "Alt+Up"],
    [key("NumpadAdd", {}, "+"), "NumpadAdd"],
  ])("%o -> %s", (e, expected) => {
    expect(captureKey(e)).toEqual({ kind: "accelerator", accelerator: expected });
  });

  it("keeps listening while only modifiers are held", () => {
    expect(captureKey(key("ControlLeft", { ctrlKey: true }, "Control"))).toEqual({ kind: "pending", preview: "Ctrl+…" });
  });

  it("cancels on Escape and clears on Backspace/Delete", () => {
    expect(captureKey(key("Escape"))).toEqual({ kind: "cancel" });
    expect(captureKey(key("Backspace"))).toEqual({ kind: "clear" });
    expect(captureKey(key("Delete"))).toEqual({ kind: "clear" });
  });

  it("refuses bare letters, Shift+letter and the Windows key", () => {
    expect(captureKey(key("KeyA", {}, "a")).kind).toBe("invalid");
    expect(captureKey(key("KeyA", { shiftKey: true }, "A")).kind).toBe("invalid");
    expect(captureKey(key("KeyA", { metaKey: true, ctrlKey: true }, "a")).kind).toBe("invalid");
    expect(captureKey(key("IntlRo")).kind).toBe("invalid");
  });

  it("maps side mouse buttons", () => {
    const none = { ctrlKey: false, altKey: false, shiftKey: false };
    expect(captureMouse(3, none)).toBe("MouseX1");
    expect(captureMouse(4, { ...none, ctrlKey: true })).toBe("Ctrl+MouseX2");
    expect(captureMouse(0, none)).toBeNull();
  });
});
