import { useCallback, useEffect, useRef, useState } from "react";
import { useVox } from "../../state/store";
import { useUpdateDialogShown } from "../../state/updates";

export const SOUND_EXTENSIONS = ["mp3", "wav", "ogg", "flac"];

/** Importing sounds into the bank: the file picker, and audio files dropped anywhere on the window. */
export function useSoundImport() {
  const { backend, call, setSnapshot, notify } = useVox();
  const [dragging, setDragging] = useState(false);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const added = await call("import_sounds", { paths });
      if (!added) return;
      setSnapshot((s) => ({ ...s, sounds: [...s.sounds, ...added] }));
      notify(added.length === 1 ? `« ${added[0]?.name} » ajouté à ta banque` : `${added.length} sons ajoutés à ta banque`);
    },
    [call, setSnapshot, notify],
  );

  const pickAndImport = useCallback(async () => {
    try {
      const paths = await backend.pickFiles({ title: "Sons audio", extensions: SOUND_EXTENSIONS, multiple: true });
      if (paths) await importPaths(paths);
    } catch (e) {
      notify(`Impossible d'ouvrir le sélecteur de fichiers : ${String(e)}`, "error");
    }
  }, [backend, importPaths, notify]);

  // The drop listener is registered once per backend; it always calls the latest importer.
  const importRef = useRef(importPaths);
  useEffect(() => {
    importRef.current = importPaths;
  }, [importPaths]);
  // Drops come from the window, not the page: while the update pop-up is modal, they are ignored.
  const modal = useUpdateDialogShown();
  const modalRef = useRef(modal);
  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    backend
      .onFileDrop((e) => {
        // A drag always ends (leave or drop), even under the pop-up; only new drags and imports wait.
        if (e.type === "leave") setDragging(false);
        else if (e.type === "over") {
          if (!modalRef.current) setDragging(true);
        } else {
          setDragging(false);
          if (modalRef.current) return;
          const audio = e.paths.filter((p) => SOUND_EXTENSIONS.some((x) => p.toLowerCase().endsWith(`.${x}`)));
          if (audio.length < e.paths.length) notify("Seuls les fichiers mp3, wav, ogg et flac sont importés.", "error");
          void importRef.current(audio);
        }
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend, notify]);

  return { dragging: dragging && !modal, pickAndImport };
}
