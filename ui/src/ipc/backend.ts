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
  /** In-app updates, read from the latest GitHub release. */
  updates: Updates;
}

export interface Updates {
  /** Version of the running app. */
  currentVersion(): Promise<string>;
  /** The newer release, or null when this version is the latest. Rejects when offline. */
  check(): Promise<AvailableUpdate | null>;
}

export interface AvailableUpdate {
  version: string;
  /**
   * Downloads, verifies the signature and installs, then restarts VoxBox. On Windows
   * the app exits as soon as the installer starts, so this only returns on failure.
   * Bounded by a timeout: a stalled download rejects instead of hanging.
   */
  install(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Frees the native handle; the owner calls it once the object is replaced or dropped. */
  release(): Promise<void>;
}

/**
 * Bytes downloaded so far; `total` is null when the server does not announce a size.
 * `finished`: the download is complete and the installer is starting.
 */
export interface UpdateProgress { downloaded: number; total: number | null; finished: boolean }

export type FileDropEvent =
  | { type: "over" }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };
