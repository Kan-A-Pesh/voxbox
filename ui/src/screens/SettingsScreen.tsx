import { useCallback, useEffect, useId, useState } from "react";
import type { DeviceInfo, DeviceSelection, Devices, HotkeyAction } from "../ipc/contract";
import { errorMessage, useVox } from "../state/store";
import { acceleratorFor, conflictFor, describeAction, reconcileSoundHotkeys } from "../lib/hotkeys";
import { PixelIcon } from "../components/PixelIcon";
import { ErrorPanel, Toggle } from "../components/Controls";
import { HotkeyCapture } from "../components/HotkeyCapture";

const GLOBAL_ACTIONS: { action: HotkeyAction; hint: string }[] = [
  { action: { type: "toggleVoice" }, hint: "Coupe ou réactive le changeur de voix." },
  { action: { type: "pushToTalk" }, hint: "Maintenu : ta voix passe (en mode push-to-talk)." },
  { action: { type: "toggleMonitor" }, hint: "T'entendre dans le casque." },
  { action: { type: "stopAllSounds" }, hint: "Coupe tous les sons de la banque." },
];

export function SettingsScreen() {
  const { snapshot, setSnapshot, backend, call, patchSettings } = useVox();
  const { settings, status, hotkeys } = snapshot;
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
    <section className="page" aria-labelledby="settings-title">
      <header className="page__head">
        <h1 className="page__title" id="settings-title">Réglages</h1>
      </header>
      <div className="settings">
        <div className="settings__col">
          {!status.cableFound ? (
            <ErrorPanel
              title="VB-Cable est introuvable"
              message="Sans ce câble audio virtuel, Discord et tes jeux ne peuvent pas recevoir ta voix modifiée. Relance l'installateur de VoxBox : il réinstalle VB-Cable. Redémarre ensuite ton PC."
            />
          ) : null}

          <div className="panel stack">
            <div className="panel__head">
              <h2 className="panel__title">Périphériques</h2>
              <button type="button" className="btn btn--small btn--ghost" onClick={refresh}>Actualiser</button>
            </div>
            {deviceError ? (
              <ErrorPanel title="Liste des périphériques indisponible" message={deviceError} />
            ) : !devices ? (
              <p className="hint" role="status">Recherche des périphériques<span className="blink">_</span></p>
            ) : (
              <>
                <DeviceSelect
                  label="Micro"
                  hint="Le micro que tu utilises vraiment."
                  icon="mic"
                  devices={devices.inputs.filter((d) => !d.isCable)}
                  value={settings.devices.input}
                  defaultLabel="Par défaut du système"
                  onChange={(v) => setDevice("input", v)}
                />
                <DeviceSelect
                  label="Sortie vers les applis (VB-Cable)"
                  hint="Dans Discord ou ton jeu, choisis « CABLE Output » comme micro."
                  icon="radio"
                  devices={devices.outputs.filter((d) => d.isCable)}
                  value={settings.devices.cable}
                  defaultLabel={status.cableFound ? "Détection automatique (CABLE Input)" : "VB-Cable non installé"}
                  onChange={(v) => setDevice("cable", v)}
                />
                <DeviceSelect
                  label="Casque"
                  hint="Pour t'entendre et écouter les sons de la banque."
                  icon="headphones"
                  devices={devices.outputs.filter((d) => !d.isCable)}
                  value={settings.devices.monitor}
                  defaultLabel="Par défaut du système"
                  onChange={(v) => setDevice("monitor", v)}
                />
                <p className="hint">
                  Latence mesurée : <span className="cyan">{Math.round(status.latencyMs)} ms</span>
                  {status.running ? "" : " · moteur arrêté"}
                </p>
              </>
            )}
          </div>

          <div className="panel stack">
            <h2 className="panel__title">Options</h2>
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
          </div>
        </div>

        <div className="settings__col">
          <div className="panel">
            <h2 className="panel__title">Raccourcis globaux</h2>
            <p className="hint">Ils marchent même en jeu. Les raccourcis des sons se règlent sur leur fiche.</p>
            <table className="hk-table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Raccourci</th>
                </tr>
              </thead>
              <tbody>
                {GLOBAL_ACTIONS.map(({ action, hint }) => {
                  const label = describeAction(action, snapshot);
                  return (
                    <tr key={action.type}>
                      <th scope="row">
                        <span className="hk-table__label">{label}</span>
                        <span className="hint">{hint}</span>
                      </th>
                      <td>
                        <HotkeyCapture
                          label={`Raccourci pour ${label}`}
                          value={acceleratorFor(hotkeys, action)}
                          onChange={(acc) => bind(action, acc)}
                          conflict={(acc) => {
                            const c = conflictFor(hotkeys, action, acc);
                            return c ? `Pris par ${describeAction(c.action, snapshot)} : réassigné ici.` : null;
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="panel stack about">
            <h2 className="panel__title">À propos</h2>
            <p className="about__line">
              <PixelIcon name="mic" scale={2} color="var(--violet)" />
              <span>VoxBox 0.1 · ta voix est traitée uniquement sur ton PC. Seul l’onglet MyInstants utilise Internet.</span>
            </p>
            <p className="about__credit">
              VB-CABLE est un donationware de VB-Audio (
              <a href="https://www.vb-cable.com" target="_blank" rel="noreferrer">www.vb-cable.com</a>
              ), toutes les participations sont les bienvenues.
            </p>
            <p className="hint">Sons en ligne fournis par MyInstants. Licences des modèles IA fournis : voir Voix IA.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DeviceSelect({ label, hint, icon, devices, value, defaultLabel, onChange }: {
  label: string;
  hint: string;
  icon: "mic" | "radio" | "headphones";
  devices: DeviceInfo[];
  value: string | null;
  defaultLabel: string;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  const missing = value !== null && !devices.some((d) => d.id === value);
  return (
    <div className="field device">
      <label className="label" htmlFor={id}>
        <PixelIcon name={icon} scale={1} /> {label}
      </label>
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
