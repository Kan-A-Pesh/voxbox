import { ErrorPanel, ProgressBar } from "./Controls";
import { Modal } from "./Modal";
import { useAiPack, useAiPackDialogShown } from "../state/aiPack";
import { useVox } from "../state/store";

/** « 790 Mo » from bytes. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} Mo`;
}

/**
 * Pop-up offering a newer « Voix IA » pack (modal, see Modal); Esc = « Plus tard ». See
 * useAiPackDialogShown for its priority over the app's own update pop-up.
 */
export function AiPackDialog() {
  const { phase, install, later } = useAiPack();
  const { snapshot } = useVox();
  const open = useAiPackDialogShown();
  const installing = phase.kind === "installing";
  const { installed, version: current } = snapshot.aiPack;
  const version = phase.kind === "none" ? 0 : phase.update.version;
  const size = phase.kind === "none" ? "" : megabytes(phase.update.size);

  return (
    <Modal
      open={open}
      title={installing ? `Mise à jour du pack Voix IA ${version}` : installed ? `Pack Voix IA ${version} disponible` : "Installer le pack Voix IA"}
      onEscape={later}
      focusKey={installing}
      returnSelector="[data-ai-pack-return]"
      actions={
        <>
          <button type="button" className="btn btn--primary" disabled={installing} onClick={install}>
            {phase.kind === "failed" ? "Réessayer" : installed ? "Mettre à jour le pack" : "Installer le pack"}
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
          <p>
            {phase.finished
              ? "Pack téléchargé et vérifié. VoxBox se ferme le temps de l’installer, puis redémarre tout seul."
              : `Téléchargement du pack (${size})…`}
          </p>
          <ProgressBar value={phase.finished ? 1 : phase.progress} label="Téléchargement du pack Voix IA" />
          <p className="hint">Si Windows demande une autorisation, réponds « Oui ».</p>
        </>
      ) : (
        <>
          {phase.kind === "failed" ? (
            <ErrorPanel title="La mise à jour du pack n’a pas pu se faire" message={phase.message} />
          ) : (
            <p>
              {installed
                ? `Tu as ${current === null ? "une ancienne version du pack" : `le pack ${current}`}. `
                : "Le pack ajoute les voix IA, leur moteur et l’import de modèles. "}
              VoxBox télécharge le pack ({size}), se ferme le temps de l’installer puis redémarre tout seul. Tes voix
              IA importées sont conservées.
            </p>
          )}
          <p className="hint">Windows te demandera une autorisation pendant l’installation.</p>
        </>
      )}
    </Modal>
  );
}
