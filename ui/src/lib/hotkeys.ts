import type { HotkeyAction, HotkeyBinding, Snapshot } from "../ipc/contract";

export const sameAction = (a: HotkeyAction, b: HotkeyAction) =>
  a.type === b.type && ("id" in a ? a.id : null) === ("id" in b ? b.id : null);

export function acceleratorFor(bindings: HotkeyBinding[], action: HotkeyAction): string | null {
  return bindings.find((b) => sameAction(b.action, action))?.accelerator ?? null;
}

export function describeAction(action: HotkeyAction, snap: Pick<Snapshot, "voices" | "sounds">): string {
  switch (action.type) {
    case "voice":
      return `Voix « ${snap.voices.find((v) => v.id === action.id)?.name ?? action.id} »`;
    case "sound":
      return `Son « ${snap.sounds.find((s) => s.id === action.id)?.name ?? action.id} »`;
    case "toggleVoice":
      return "Activer / couper la voix";
    case "toggleMonitor":
      return "M'entendre";
    case "pushToTalk":
      return "Push-to-talk";
    case "stopAllSounds":
      return "Stopper les sons";
  }
}

/** Another binding already using this accelerator, if any. */
export function conflictFor(bindings: HotkeyBinding[], action: HotkeyAction, accelerator: string) {
  return bindings.find((b) => b.accelerator.toLowerCase() === accelerator.toLowerCase() && !sameAction(b.action, action)) ?? null;
}

/** Sound.hotkey mirrors the canonical binding table; call after any binding change. */
export function reconcileSoundHotkeys<S extends { id: string; hotkey: string | null }>(sounds: S[], bindings: HotkeyBinding[]): S[] {
  return sounds.map((s) => {
    const hotkey = acceleratorFor(bindings, { type: "sound", id: s.id });
    return s.hotkey === hotkey ? s : { ...s, hotkey };
  });
}
