import type { Commands, Events } from "./contract";

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K][0];
export type CommandResult<K extends CommandName> = Commands[K][1];
export type EventName = keyof Events;
export type Unlisten = () => void;

/** Transport-agnostic backend: Tauri IPC in the app, in-memory mock in a browser or tests. */
export interface Backend {
  invoke<K extends CommandName>(cmd: K, args: CommandArgs<K>): Promise<CommandResult<K>>;
  listen<E extends EventName>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten>;
  /** Native file picker. Returns absolute paths, or null when cancelled. */
  pickFiles(options: { title: string; extensions: string[]; multiple: boolean }): Promise<string[] | null>;
  /** OS file drops onto the window (absolute paths). */
  onFileDrop(handler: (event: FileDropEvent) => void): Promise<Unlisten>;
}

export type FileDropEvent =
  | { type: "over" }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };
