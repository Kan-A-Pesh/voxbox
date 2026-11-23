import { useState } from "react";
import { useVox } from "../../state/store";
import { PixelIcon } from "../../components/PixelIcon";
import { SidePanel } from "../../components/SidePanel";
import { RvcSettings } from "./RvcSettings";

/** An AI (RVC) voice: what it is, the shared RVC settings, and deleting an imported model. */
export function AiVoicePanel({ voiceId, onClose, onDeleted }: { voiceId: string; onClose: () => void; onDeleted: () => void }) {
  const { snapshot, setSnapshot, call, notify, selectVoice } = useVox();
  const voice = snapshot.voices.find((v) => v.id === voiceId);
  const model = snapshot.aiModels.find((m) => m.id === voice?.aiModelId);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!voice || !model) {
    return (
      <SidePanel title="Voix IA" onClose={onClose}>
        <p className="hint">Cette voix IA n'existe plus.</p>
      </SidePanel>
    );
  }

  const active = snapshot.settings.activeVoiceId === voice.id;

  async function use() {
    await selectVoice(voiceId);
  }

  async function remove() {
    if (!model) return;
    const ok = await call("delete_ai_model", { id: model.id });
    setConfirmDelete(false);
    if (ok === undefined) return;
    const snap = await call("get_snapshot", {});
    setSnapshot((s) => snap ?? { ...s, aiModels: s.aiModels.filter((x) => x.id !== model.id) });
    notify(`Modèle « ${model.name} » supprimé`);
    onDeleted();
  }

  return (
    <SidePanel title="Voix IA" onClose={onClose}>
      <div className="panel-form">
        <div className="identity">
          <span className="identity__icon" aria-hidden="true">
            <PixelIcon name={voice.icon} scale={3} color={voice.color} />
          </span>
          <div>
            <p className="identity__name">
              {voice.name}
              <span className="tag-ai">IA</span>
            </p>
            <p className="hint">
              {(model.modelSampleRate / 1000).toLocaleString("fr-FR")} kHz · {model.hasIndex ? "avec index" : "sans index"}
              {model.builtin ? " · fournie avec VoxBox" : ""}
            </p>
            {model.license ? <p className="hint">Licence : {model.license}</p> : null}
          </div>
        </div>

        <div className="panel-actions">
          <button type="button" className="btn btn--primary" onClick={use} disabled={active}>
            {active ? "Voix active" : "Utiliser"}
          </button>
        </div>

        <section className="stack" aria-labelledby="rvc-title">
          <div>
            <h3 className="section-title" id="rvc-title">Réglages IA</h3>
            <p className="hint">Communs à toutes les voix IA.</p>
          </div>
          <RvcSettings />
        </section>

        {!model.builtin ? (
          <div className="danger-zone">
            {confirmDelete ? (
              <div className="row" role="group" aria-label="Confirmer la suppression">
                <span className="hint">Supprimer le modèle « {model.name} » ?</span>
                <button type="button" className="btn btn--danger" onClick={remove}>Supprimer</button>
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>Garder</button>
              </div>
            ) : (
              <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirmDelete(true)}>
                Supprimer cette voix IA
              </button>
            )}
          </div>
        ) : null}
      </div>
    </SidePanel>
  );
}
