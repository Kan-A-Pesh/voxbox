// Keyboard/mouse event -> accelerator string, as documented in ipc/contract.ts:
// "Ctrl+Alt+1", "F13", "Shift+F2", "Numpad5", "MouseX1". Modifier order: Ctrl, Alt, Shift.

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}

export type CaptureResult =
  | { kind: "accelerator"; accelerator: string }
  /** Only modifiers held so far: keep listening. */
  | { kind: "pending"; preview: string }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`",
  Backslash: "\\", Comma: ",", Period: ".", Slash: "/",
  NumpadAdd: "NumpadAdd", NumpadSubtract: "NumpadSubtract", NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide", NumpadDecimal: "NumpadDecimal", NumpadEnter: "NumpadEnter",
  Pause: "Pause", ScrollLock: "ScrollLock", PrintScreen: "PrintScreen",
  MediaPlayPause: "MediaPlayPause", MediaTrackNext: "MediaTrackNext", MediaTrackPrevious: "MediaTrackPrevious",
};

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight",
]);

function modifiers(e: KeyLike): string[] {
  const m: string[] = [];
  if (e.ctrlKey) m.push("Ctrl");
  if (e.altKey) m.push("Alt");
  if (e.shiftKey) m.push("Shift");
  return m;
}

/** Physical key (layout independent: AZERTY "&" key is still "1"). */
export function keyName(code: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1] ?? null;
  if ((m = code.match(/^Digit([0-9])$/))) return m[1] ?? null;
  if ((m = code.match(/^Numpad([0-9])$/))) return `Numpad${m[1]}`;
  if ((m = code.match(/^F([1-9]|1[0-9]|2[0-4])$/))) return `F${m[1]}`;
  return NAMED[code] ?? null;
}

/** Keys that are safe as a global shortcut without any modifier. */
function standalone(name: string): boolean {
  return /^F\d+$/.test(name) || name.startsWith("Numpad") || name.startsWith("Media") ||
    ["Pause", "ScrollLock", "PrintScreen", "Insert"].includes(name);
}

export function captureKey(e: KeyLike): CaptureResult {
  const mods = modifiers(e);
  if (MODIFIER_CODES.has(e.code) || ["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) {
    return { kind: "pending", preview: mods.length ? `${mods.join("+")}+…` : "…" };
  }
  if (e.code === "Escape" && mods.length === 0) return { kind: "cancel" };
  if ((e.code === "Backspace" || e.code === "Delete") && mods.length === 0) return { kind: "clear" };
  if (e.metaKey) return { kind: "invalid", message: "La touche Windows est réservée par le système." };
  const name = keyName(e.code);
  if (!name) return { kind: "invalid", message: "Cette touche n'est pas prise en charge." };
  if (mods.length === 0 && !standalone(name)) {
    return { kind: "invalid", message: `« ${name} » seul bloquerait ta frappe : ajoute Ctrl, Alt ou Shift.` };
  }
  if (mods.length === 1 && mods[0] === "Shift" && !standalone(name)) {
    return { kind: "invalid", message: "Shift seul change juste la casse : ajoute Ctrl ou Alt." };
  }
  return { kind: "accelerator", accelerator: [...mods, name].join("+") };
}

/** Side mouse buttons (MouseEvent.button 3/4) are popular push-to-talk keys. */
export function captureMouse(button: number, e: Pick<KeyLike, "ctrlKey" | "altKey" | "shiftKey">): string | null {
  const name = button === 3 ? "MouseX1" : button === 4 ? "MouseX2" : null;
  if (!name) return null;
  return [...modifiers({ ...e, key: "", code: "" }), name].join("+");
}
