import { useUpdates } from "../state/updates";

/** One line above the page while a newer release waits (after « Plus tard »). */
export function UpdateBanner() {
  const { phase, dialogOpen, install } = useUpdates();
  // While installing, the pop-up stays open and shows the progress.
  if ((phase.kind !== "available" && phase.kind !== "failed") || dialogOpen) return null;
  const { version } = phase.update;
  const failed = phase.kind === "failed";
  // data-update-return: focus comes back here when the pop-up closes and its opener is gone.
  return (
    <div className="update-banner" role="status">
      <span className="update-banner__dot" aria-hidden="true" />
      <p>{failed ? `La mise à jour vers VoxBox ${version} a échoué.` : `VoxBox ${version} est disponible.`}</p>
      <button type="button" className="link-btn" onClick={install} data-update-return="">
        {failed ? "Réessayer" : "Mettre à jour"}
      </button>
    </div>
  );
}
