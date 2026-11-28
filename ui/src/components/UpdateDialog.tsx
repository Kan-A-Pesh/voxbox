import { ErrorPanel, ProgressBar } from "./Controls";
import { Modal } from "./Modal";
import { useUpdateDialogShown, useUpdates } from "../state/updates";

/** Pop-up offering a newer release (modal, see Modal); Esc = « Plus tard ». */
export function UpdateDialog() {
  const { phase, currentVersion, install, later } = useUpdates();
  const open = useUpdateDialogShown();
  const installing = phase.kind === "installing";
  const version = phase.kind === "none" ? "" : phase.update.version;

  return (
    <Modal
      open={open && phase.kind !== "none"}
      title={installing ? `Mise à jour vers ${version}` : `VoxBox ${version} est disponible`}
      onEscape={later}
      focusKey={installing}
      // The banner's action: focus comes back to it when the pop-up closes and its opener is gone.
      returnSelector="[data-update-return]"
      actions={
        <>
          <button type="button" className="btn btn--primary" disabled={installing} onClick={install}>
            {phase.kind === "failed" ? "Réessayer" : "Mettre à jour"}
          </button>
          {installing ? null : (
            <button type="button" className="btn btn--ghost" onClick={later}>
              Plus tard
            </button>
          )}
        </>
      }
    >
      {phase.kind === "installing" ? (
        <>
          <p>{phase.finished ? "Installation… VoxBox redémarre tout seul dans un instant." : "Téléchargement…"}</p>
          <ProgressBar value={phase.finished ? 1 : phase.progress ?? 0} label="Téléchargement de la mise à jour" />
          <p className="hint">Si Windows demande une autorisation, réponds « Oui ».</p>
        </>
      ) : (
        <>
          {phase.kind === "failed" ? (
            <ErrorPanel title="La mise à jour n’a pas pu se faire" message={phase.message} />
          ) : (
            <p>
              Tu as la version {currentVersion ?? "actuelle"}. VoxBox télécharge la nouvelle, l’installe puis
              redémarre tout seul. Tes réglages, voix et sons sont conservés.
            </p>
          )}
          <p className="hint">Windows te demandera une autorisation pendant l’installation.</p>
        </>
      )}
    </Modal>
  );
}
