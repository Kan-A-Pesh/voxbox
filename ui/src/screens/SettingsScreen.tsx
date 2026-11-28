import { useCallback, useEffect, useId, useState } from "react";
import type { AiBackend, DeviceInfo, DeviceSelection, Devices, HotkeyAction } from "../ipc/contract";
import { errorMessage, useVox } from "../state/store";
import { useUpdates } from "../state/updates";
import { useAiPack } from "../state/aiPack";
import { acceleratorFor, conflictFor, describeAction, reconcileSoundHotkeys } from "../lib/hotkeys";
import { ErrorPanel, Slider, Toggle } from "../components/Controls";
import { HotkeyCapture } from "../components/HotkeyCapture";
import { RvcSettings } from "./voices/RvcSettings";

const GLOBAL_ACTIONS: { action: HotkeyAction; hint: string }[] = [
  { action: { type: "toggleVoice" }, hint: "Coupe ou réactive le changeur de voix." },
  { action: { type: "pushToTalk" }, hint: "Maintenu : ta voix passe (en mode push-to-talk)." },
  { action: { type: "toggleMonitor" }, hint: "T'entendre dans le casque." },
  { action: { type: "stopAllSounds" }, hint: "Coupe tous les sons de la banque." },
];

const BACKEND_LABEL: Record<AiBackend, string> = { cuda: "CUDA", directMl: "DirectML", cpu: "CPU" };
const pct = (v: number) => `${Math.round(v * 100)} %`;

export function SettingsScreen() {
  const { snapshot, setSnapshot, backend, call, patchSettings } = useVox();
  const { settings, status, hotkeys, aiBackend } = snapshot;
  const [devices, setDevices] = useState<Devices | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const fetchDevices = useCallback(
    () =>
      backend.invoke("list_devices", {}).then(
        (d) => {
          setDevices(d);
          setDeviceError(null);
        },
        (e: unknown) => setDeviceError(errorMessage(e)),
      ),
    [backend],
  );
  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);
  const refresh = () => {
    setDevices(null);
    setDeviceError(null);
    void fetchDevices();
  };

  const setDevice = (key: keyof DeviceSelection, value: string | null) =>
    patchSettings({ devices: { ...settings.devices, [key]: value } });

  async function bind(action: HotkeyAction, accelerator: string | null) {
    const next = await call("set_hotkey", { action, accelerator });
    if (next) setSnapshot((s) => ({ ...s, hotkeys: next, sounds: reconcileSoundHotkeys(s.sounds, next) }));
  }

  return (
    <section className="page page--narrow" aria-labelledby="settings-title">
      <header className="page__head">
        <h1 className="page__title" id="settings-title">Réglages</h1>
      </header>

      <section className="settings-section" aria-labelledby="set-devices">
        <div className="section-head">
          <h2 className="section-title" id="set-devices">Périphériques</h2>
          <button type="button" className="link-btn" onClick={refresh}>Actualiser</button>
        </div>
        {!status.cableFound ? (
          <ErrorPanel
            title="VB-Cable est introuvable"
            message="Sans ce câble audio virtuel, Discord et tes jeux ne peuvent pas recevoir ta voix modifiée. Relance l'installateur de VoxBox : il réinstalle VB-Cable. Redémarre ensuite ton PC."
          />
        ) : null}
        {!status.running && status.lastError ? (
          <ErrorPanel
            title={status.restarting ? "Le son est coupé, nouvelle tentative automatique" : "Le son est coupé"}
            message={status.lastError}
            logged
            action={
              <button type="button" className="link-btn" onClick={() => void call("open_logs_folder", {})}>
                Ouvrir le dossier des journaux
              </button>
            }
          />
        ) : null}
        {status.running ? (
          <div className="stack stack--tight">
            <p className="label">Utilisés en ce moment</p>
            <dl className="meta-list" aria-label="Périphériques du moteur audio">
              <dt>Micro</dt>
              <dd>{status.inputName ?? "Par défaut du système"}</dd>
              <dt>Sortie</dt>
              <dd>{status.cableFound ? status.cableName ?? "CABLE Input (VB-Cable)" : "VB-Cable introuvable"}</dd>
              <dt>Casque</dt>
              <dd>{status.monitorName ?? "Aucun casque ouvert"}</dd>
            </dl>
          </div>
        ) : status.inputName || status.cableName ? (
          // Stopped: no stream is open, the status keeps the names of the last ones (never invented ones).
          <div className="stack stack--tight">
            <p className="label">Derniers périphériques utilisés</p>
            <dl className="meta-list" aria-label="Périphériques du moteur audio">
              {status.inputName ? (
                <>
                  <dt>Micro</dt>
                  <dd>{status.inputName}</dd>
                </>
              ) : null}
              {status.cableName ? (
                <>
                  <dt>Sortie</dt>
                  <dd>{status.cableName}</dd>
                </>
              ) : null}
              {status.monitorName ? (
                <>
                  <dt>Casque</dt>
                  <dd>{status.monitorName}</dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}
        {deviceError ? (
          <ErrorPanel title="Liste des périphériques indisponible" message={deviceError} />
        ) : !devices ? (
          <p className="hint" role="status">Recherche des périphériques…</p>
        ) : (
          <>
            <DeviceSelect
              label="Micro"
              hint={
                status.running && status.fallback
                  ? `Tes périphériques choisis sont indisponibles : ceux du système sont utilisés en attendant (micro « ${status.inputName ?? "par défaut"} »). VoxBox y revient tout seul dès qu'ils sont branchés.`
                  : "Le micro que tu utilises vraiment."
              }
              devices={devices.inputs.filter((d) => !d.isCable)}
              value={settings.devices.input}
              defaultLabel="Par défaut du système"
              onChange={(v) => setDevice("input", v)}
            />
            <DeviceSelect
              label="Sortie vers les applis (VB-Cable)"
              hint="Dans Discord ou ton jeu, choisis « CABLE Output » comme micro."
              devices={devices.outputs.filter((d) => d.isCable)}
              value={settings.devices.cable}
              defaultLabel={status.cableFound ? "Détection automatique (CABLE Input)" : "VB-Cable non installé"}
              onChange={(v) => setDevice("cable", v)}
            />
            <DeviceSelect
              label="Casque"
              hint="Pour t'entendre et écouter les sons de la banque."
              devices={devices.outputs.filter((d) => !d.isCable)}
              value={settings.devices.monitor}
              defaultLabel="Par défaut du système"
              onChange={(v) => setDevice("monitor", v)}
            />
            <p className="hint">
              Latence mesurée : <span className="mono">{Math.round(status.latencyMs)} ms</span>
              {status.running ? "" : status.restarting ? " · moteur arrêté, relance automatique en cours" : " · moteur arrêté"}
            </p>
          </>
        )}
      </section>

      <section className="settings-section" aria-labelledby="set-options">
        <h2 className="section-title" id="set-options">Options</h2>
        <Toggle
          label="Anti-bruit"
          hint="Filtre le clavier, le ventilo et le bruit de fond du micro."
          checked={settings.noiseSuppression}
          onChange={(noiseSuppression) => patchSettings({ noiseSuppression })}
        />
        <Toggle
          label="Mode push-to-talk"
          hint="Ta voix ne passe que pendant que tu maintiens le raccourci."
          checked={settings.pttMode}
          onChange={(pttMode) => patchSettings({ pttMode })}
        />
        <Toggle
          label="Démarrer réduit"
          hint="VoxBox s'ouvre directement dans la zone de notification."
          checked={settings.startMinimized}
          onChange={(startMinimized) => patchSettings({ startMinimized })}
        />
      </section>

      <section className="settings-section" aria-labelledby="set-hotkeys">
        <div>
          <h2 className="section-title" id="set-hotkeys">Raccourcis</h2>
          <p className="hint">Ils marchent même en jeu. Les raccourcis des sons se règlent sur leur fiche.</p>
        </div>
        <ul className="hk-list">
          {GLOBAL_ACTIONS.map(({ action, hint }) => {
            const label = describeAction(action, snapshot);
            return (
              <li key={action.type} className="hk-row">
                <span className="hk-row__text">
                  <span className="hk-row__label">{label}</span>
                  <span className="hint">{hint}</span>
                </span>
                <HotkeyCapture
                  label={`Raccourci pour ${label}`}
                  value={acceleratorFor(hotkeys, action)}
                  onChange={(acc) => bind(action, acc)}
                  conflict={(acc) => {
                    const c = conflictFor(hotkeys, action, acc);
                    return c ? `Pris par ${describeAction(c.action, snapshot)} : réassigné ici.` : null;
                  }}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="settings-section" aria-labelledby="set-ai">
        <h2 className="section-title" id="set-ai">Voix IA</h2>
        <p className="setting-line">
          <span className="tag-ai">{BACKEND_LABEL[aiBackend.backend]}</span>
          <span>{aiBackend.deviceName}</span>
        </p>
        <p className="hint">
          {aiBackend.backend === "cpu"
            ? "Aucun GPU compatible : la conversion IA tourne sur le processeur, attends-toi à beaucoup de latence."
            : "Conversion RVC accélérée par ta carte graphique, 100 % en local."}
        </p>
        <AiPackVersion />
        <div>
          <h3 className="section-title">Réglages IA</h3>
          <p className="hint">Communs à toutes les voix IA ; aussi dans le panneau de chaque voix IA, sur l'écran Voix.</p>
        </div>
        <RvcSettings />
      </section>

      <section className="settings-section" aria-labelledby="set-sounds">
        <h2 className="section-title" id="set-sounds">Sons</h2>
        <Slider
          label="Vers le micro"
          hint="Ce que les autres entendent."
          value={settings.soundMicVolume}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          onChange={(soundMicVolume) => patchSettings({ soundMicVolume })}
        />
        <Slider
          label="Dans mon casque"
          hint="Ce que tu entends."
          value={settings.soundMonitorVolume}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          onChange={(soundMonitorVolume) => patchSettings({ soundMonitorVolume })}
        />
      </section>

      <section className="settings-section" aria-labelledby="set-about">
        <h2 className="section-title" id="set-about">À propos</h2>
        <AboutVersion />
        <p>Ta voix est traitée uniquement sur ton PC. Seuls l’onglet MyInstants et la recherche de mises à jour utilisent Internet.</p>
        <p className="about__credit">
          VB-CABLE est un donationware de VB-Audio (
          <a href="https://www.vb-cable.com" target="_blank" rel="noreferrer">www.vb-cable.com</a>
          ), toutes les participations sont les bienvenues.
        </p>
        <p className="hint">Sons en ligne fournis par MyInstants. Licence de chaque voix IA fournie : dans son panneau, sur l'écran Voix.</p>
        <p>
          <button type="button" className="link-btn" onClick={() => void call("open_logs_folder", {})}>
            Ouvrir le dossier des journaux
          </button>
        </p>
      </section>
    </section>
  );
}

function DeviceSelect({ label, hint, devices, value, defaultLabel, onChange }: {
  label: string;
  hint: string;
  devices: DeviceInfo[];
  value: string | null;
  defaultLabel: string;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  const missing = value !== null && !devices.some((d) => d.id === value);
  return (
    <div className="field device">
      <label className="label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-describedby={`${id}-hint`}
      >
        <option value="">{defaultLabel}</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}{d.isDefault ? " (par défaut)" : ""}
          </option>
        ))}
        {missing ? <option value={value}>Périphérique débranché</option> : null}
      </select>
      <p className="hint" id={`${id}-hint`}>
        {missing ? "Ce périphérique n'est plus branché : rebranche-le ou choisis-en un autre." : hint}
      </p>
    </div>
  );
}

/** The installed « Voix IA » pack and its update (Réglages → Voix IA). */
function AiPackVersion() {
  const { snapshot } = useVox();
  const { phase, manual, checkNow, offer } = useAiPack();
  const { installed, version } = snapshot.aiPack;
  const pending = phase.kind !== "none" ? phase.update.version : null;
  const installing = phase.kind === "installing";
  return (
    <div className="about__version">
      <p>
        Pack Voix IA{" "}
        <span className="mono">{!installed ? "non installé" : version === null ? "ancienne version" : version}</span>
      </p>
      {pending ? (
        <button type="button" className="btn btn--small btn--primary" onClick={offer}>
          {installed ? `Installer le pack ${pending}` : "Installer le pack"}
        </button>
      ) : null}
      <button type="button" className="btn btn--small" disabled={manual.kind === "checking" || installing} onClick={checkNow}>
        {manual.kind === "checking" ? "Recherche…" : "Rechercher une mise à jour du pack"}
      </button>
      <p className="hint" role="status">
        {manual.kind === "upToDate" && !pending ? "Tu as le dernier pack publié." : null}
        {manual.kind === "failed" ? `Recherche impossible : ${manual.message}` : null}
      </p>
    </div>
  );
}

function AboutVersion() {
  const { currentVersion, phase, manual, checkNow, openDialog } = useUpdates();
  const pending = phase.kind !== "none" ? phase.update.version : null;
  const installing = phase.kind === "installing";
  return (
    <div className="about__version">
      <p>
        VoxBox <span className="mono">{currentVersion ?? "…"}</span>
      </p>
      {pending ? (
        <button type="button" className="btn btn--small btn--primary" onClick={openDialog}>
          Installer la version {pending}
        </button>
      ) : null}
      {/* Still available with an update pending: the release may have been withdrawn or superseded. */}
      <button type="button" className="btn btn--small" disabled={manual.kind === "checking" || installing} onClick={checkNow}>
        {manual.kind === "checking" ? "Recherche…" : "Rechercher une mise à jour"}
      </button>
      <p className="hint" role="status">
        {manual.kind === "upToDate" && !pending ? "Tu as la dernière version." : null}
        {manual.kind === "failed" ? `Recherche impossible : ${manual.message}` : null}
      </p>
    </div>
  );
}
