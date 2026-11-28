import { useAiPack } from "../state/aiPack";
import { useVox } from "../state/store";

/** One line above the page while a newer « Voix IA » pack waits (after « Plus tard »). */
export function AiPackBanner() {
  const { phase, dialogOpen, install } = useAiPack();
  const { snapshot } = useVox();
  // Only for an installed pack (the pack is optional); while installing, the pop-up shows the progress.
  if (!snapshot.aiPack.installed || (phase.kind !== "available" && phase.kind !== "failed") || dialogOpen) return null;
  const { version } = phase.update;
  const failed = phase.kind === "failed";
  // data-ai-pack-return: focus comes back here when the pop-up closes and its opener is gone.
  return (
    <div className="update-banner" role="status">
      <span className="update-banner__dot" aria-hidden="true" />
      <p>{failed ? `La mise à jour du pack Voix IA ${version} a échoué.` : `Pack Voix IA ${version} disponible.`}</p>
      <button type="button" className="link-btn" onClick={install} data-ai-pack-return="">
        {failed ? "Réessayer" : "Mettre à jour le pack"}
      </button>
    </div>
  );
}
