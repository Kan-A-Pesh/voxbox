//! Persistent user data in `%APPDATA%\com.voxbox.app\`: settings, custom voices,
//! sound bank and hotkeys as JSON files (written atomically), sound files under
//! `sounds/`, converted AI models under `models/`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use voxbox_dsp::{VoiceCategory, VoicePreset};
use voxbox_engine::{DeviceSelection, Devices};
use voxbox_rvc::{AiModelMeta, RvcParams};

use crate::hotkeys::{parse_accelerator, HotkeyAction, HotkeyBinding};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("impossible d'enregistrer {path} : {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("voix introuvable : {0}")]
    VoiceNotFound(String),
    #[error(
        "les voix intégrées ne peuvent pas être modifiées ou supprimées, dupliquez-les d'abord"
    )]
    BuiltinVoice,
    #[error("son introuvable : {0}")]
    SoundNotFound(String),
    #[error("raccourci invalide « {accelerator} » : {reason}")]
    InvalidHotkey { accelerator: String, reason: String },
    #[error("le nom ne peut pas être vide")]
    EmptyName,
    #[error("{save} ; les périphériques précédents n'ont pas pu être rouverts ({reopen}). Vérifiez vos périphériques dans Réglages")]
    DevicesNotRestored { save: String, reopen: String },
    #[cfg(test)]
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub devices: DeviceSelection,
    pub voice_enabled: bool,
    pub active_voice_id: String,
    pub monitor: bool,
    pub noise_suppression: bool,
    pub ptt_mode: bool,
    pub sound_mic_volume: f32,
    pub sound_monitor_volume: f32,
    pub ai_params: RvcParams,
    pub start_minimized: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            devices: DeviceSelection::default(),
            voice_enabled: true,
            active_voice_id: String::from("villager"),
            monitor: false,
            noise_suppression: true,
            ptt_mode: false,
            sound_mic_volume: 0.8,
            sound_monitor_volume: 0.5,
            ai_params: RvcParams::default(),
            start_minimized: false,
        }
    }
}

/// Partial update sent by the UI (`update_settings`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub devices: Option<DeviceSelection>,
    pub voice_enabled: Option<bool>,
    pub active_voice_id: Option<String>,
    pub monitor: Option<bool>,
    pub noise_suppression: Option<bool>,
    pub ptt_mode: Option<bool>,
    pub sound_mic_volume: Option<f32>,
    pub sound_monitor_volume: Option<f32>,
    pub ai_params: Option<RvcParams>,
    pub start_minimized: Option<bool>,
}

impl AppSettings {
    pub fn apply(&mut self, p: SettingsPatch) {
        if let Some(v) = p.devices {
            self.devices = v;
        }
        if let Some(v) = p.voice_enabled {
            self.voice_enabled = v;
        }
        if let Some(v) = p.active_voice_id {
            self.active_voice_id = v;
        }
        if let Some(v) = p.monitor {
            self.monitor = v;
        }
        if let Some(v) = p.noise_suppression {
            self.noise_suppression = v;
        }
        if let Some(v) = p.ptt_mode {
            self.ptt_mode = v;
        }
        if let Some(v) = p.sound_mic_volume {
            self.sound_mic_volume = v.clamp(0.0, 1.0);
        }
        if let Some(v) = p.sound_monitor_volume {
            self.sound_monitor_volume = v.clamp(0.0, 1.0);
        }
        if let Some(v) = p.ai_params {
            self.ai_params = clamp_ai_params(v);
        }
        if let Some(v) = p.start_minimized {
            self.start_minimized = v;
        }
    }
}

/// Commits a settings change and publishes the result to the engine under the
/// same lock, so two concurrent changes can never leave the engine on an older
/// value than the one saved (e.g. push-to-talk saved on, microphone left open).
/// `publish` must be quick (engine atomics) and must not take the store lock.
pub fn commit_and_publish<E: From<StoreError> + std::fmt::Display>(
    store: &parking_lot::Mutex<Store>,
    change: impl FnOnce(&mut AppSettings),
    devices: Option<DeviceSelection>,
    open: impl FnMut(&DeviceSelection) -> Result<(), E>,
    publish: impl FnOnce(&AppSettings),
) -> Result<AppSettings, E> {
    let mut store = store.lock();
    let mut next = store.settings.clone();
    change(&mut next);
    let devices_changed = devices.is_some();
    if let Some(devices) = devices {
        next.devices = devices;
    }
    store.commit_settings(next, devices_changed, open)?;
    publish(&store.settings);
    Ok(store.settings.clone())
}

/// Drops saved devices that are no longer plugged in (back to "system default" /
/// "auto-detect CABLE Input"), so a headset unplugged since the last session can
/// never make a device change fail. Mirrors `sanitizeDevices` in ui/src/ipc/mock.ts.
pub fn sanitize_devices(selection: DeviceSelection, available: &Devices) -> DeviceSelection {
    let keep = |id: Option<String>, list: &[voxbox_engine::DeviceInfo]| {
        id.filter(|id| list.iter().any(|d| &d.id == id))
    };
    DeviceSelection {
        input: keep(selection.input, &available.inputs),
        cable: keep(selection.cable, &available.outputs),
        monitor: keep(selection.monitor, &available.outputs),
    }
}

/// Valid AI-voice settings; mirrors `clampRvcParams` in ui/src/lib/rvcParams.ts.
/// Block and crossfade are snapped to 10 ms like the RVC worker does.
fn clamp_ai_params(mut v: RvcParams) -> RvcParams {
    let finite = |x: f32, default: f32| if x.is_finite() { x } else { default };
    v.pitch_semitones = finite(v.pitch_semitones, 0.0).clamp(-12.0, 12.0);
    v.index_rate = finite(v.index_rate, 0.0).clamp(0.0, 1.0);
    v.block_ms = v.block_ms.clamp(100, 1000) / 10 * 10;
    let max_crossfade = (v.block_ms / 2 / 10 * 10).min(200);
    v.crossfade_ms = v.crossfade_ms.clamp(10, max_crossfade) / 10 * 10;
    v
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundSource {
    Local,
    Myinstants,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub favorite: bool,
    pub volume: f32,
    #[serde(rename = "loop")]
    pub looped: bool,
    pub hotkey: Option<String>,
    pub duration_ms: u32,
    pub source: SoundSource,
    pub source_url: Option<String>,
}

/// Where a sound's audio lives on disk (kept out of the UI contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSound {
    #[serde(flatten)]
    pub sound: Sound,
    pub file: String,
}

pub struct Store {
    dir: PathBuf,
    pub settings: AppSettings,
    pub custom_voices: Vec<VoicePreset>,
    pub sounds: Vec<StoredSound>,
    pub hotkeys: Vec<HotkeyBinding>,
}

const SETTINGS: &str = "settings.json";
const VOICES: &str = "voices.json";
const SOUNDS: &str = "sounds.json";
const HOTKEYS: &str = "hotkeys.json";

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            // Keep the unreadable file for inspection instead of silently losing it.
            let backup = path.with_extension("json.corrupt");
            tracing::error!(
                "{} illisible ({e}), sauvegardé dans {}",
                path.display(),
                backup.display()
            );
            let _ = fs::rename(path, &backup);
            T::default()
        }),
        Err(_) => T::default(),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let err = |source| StoreError::Write {
        path: path.to_path_buf(),
        source,
    };
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| err(std::io::Error::other(e)))?;
    fs::write(&tmp, bytes).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

pub fn default_hotkeys() -> Vec<HotkeyBinding> {
    let b = |action, acc: &str| HotkeyBinding {
        action,
        accelerator: acc.to_string(),
    };
    let mut v = vec![
        b(HotkeyAction::ToggleVoice, "Ctrl+Alt+V"),
        b(HotkeyAction::ToggleMonitor, "Ctrl+Alt+M"),
        b(HotkeyAction::StopAllSounds, "Ctrl+Alt+S"),
        b(HotkeyAction::PushToTalk, "Ctrl+Alt+T"),
    ];
    for (i, preset) in voxbox_dsp::builtin_presets().iter().take(9).enumerate() {
        v.push(b(
            HotkeyAction::Voice {
                id: preset.id.clone(),
            },
            &format!("Ctrl+Alt+{}", i + 1),
        ));
    }
    v
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        let mk = |p: &Path| {
            fs::create_dir_all(p).map_err(|source| StoreError::Write {
                path: p.to_path_buf(),
                source,
            })
        };
        mk(dir)?;
        mk(&dir.join("sounds"))?;
        mk(&dir.join("models"))?;
        let hotkeys_path = dir.join(HOTKEYS);
        let hotkeys = if hotkeys_path.exists() {
            read_json(&hotkeys_path)
        } else {
            default_hotkeys()
        };
        Ok(Self {
            dir: dir.to_path_buf(),
            settings: read_json(&dir.join(SETTINGS)),
            custom_voices: read_json(&dir.join(VOICES)),
            sounds: read_json(&dir.join(SOUNDS)),
            hotkeys,
        })
    }

    pub fn sounds_dir(&self) -> PathBuf {
        self.dir.join("sounds")
    }

    pub fn models_dir(&self) -> PathBuf {
        self.dir.join("models")
    }

    pub fn save_settings(&self) -> Result<(), StoreError> {
        write_json(&self.dir.join(SETTINGS), &self.settings)
    }

    fn save_voices(&self) -> Result<(), StoreError> {
        write_json(&self.dir.join(VOICES), &self.custom_voices)
    }

    fn save_sounds(&self) -> Result<(), StoreError> {
        write_json(&self.dir.join(SOUNDS), &self.sounds)
    }

    fn save_hotkeys(&self) -> Result<(), StoreError> {
        write_json(&self.dir.join(HOTKEYS), &self.hotkeys)
    }

    /// Applies a whole settings change with one persistence boundary. When
    /// `devices_changed`, `open` (the audio engine) must accept `next.devices`
    /// first; a rejected selection is never stored. If saving fails, memory goes
    /// back to the saved settings and the previous devices are reopened. If that
    /// reopen fails too, the engine state is unknown: memory keeps the saved
    /// settings, the error carries both causes, and callers re-read the engine
    /// status rather than assume which devices are running.
    pub fn commit_settings<E: From<StoreError> + std::fmt::Display>(
        &mut self,
        next: AppSettings,
        devices_changed: bool,
        mut open: impl FnMut(&DeviceSelection) -> Result<(), E>,
    ) -> Result<(), E> {
        let previous = std::mem::replace(&mut self.settings, next);
        if devices_changed {
            if let Err(e) = open(&self.settings.devices) {
                self.settings = previous;
                return Err(e);
            }
        }
        let Err(save_error) = self.save_settings() else {
            return Ok(());
        };
        self.settings = previous;
        if devices_changed {
            if let Err(reopen) = open(&self.settings.devices) {
                return Err(StoreError::DevicesNotRestored {
                    save: save_error.to_string(),
                    reopen: reopen.to_string(),
                }
                .into());
            }
        }
        Err(save_error.into())
    }

    /// Built-in voices, then AI voices (one per model unless the user saved a
    /// custom preset for it), then custom voices.
    pub fn voices(&self, ai_models: &[AiModelMeta]) -> Vec<VoicePreset> {
        let mut out = voxbox_dsp::builtin_presets();
        for m in ai_models {
            let customized = self
                .custom_voices
                .iter()
                .any(|v| v.ai_model_id.as_deref() == Some(&m.id));
            if !customized {
                out.push(ai_preset(m));
            }
        }
        out.extend(self.custom_voices.iter().cloned());
        out
    }

    pub fn find_voice(&self, id: &str, ai_models: &[AiModelMeta]) -> Option<VoicePreset> {
        self.voices(ai_models).into_iter().find(|v| v.id == id)
    }

    pub fn save_voice(&mut self, mut voice: VoicePreset) -> Result<VoicePreset, StoreError> {
        if voice.name.trim().is_empty() {
            return Err(StoreError::EmptyName);
        }
        let is_builtin_id = voxbox_dsp::builtin_presets()
            .iter()
            .any(|b| b.id == voice.id);
        if voice.id.is_empty() || is_builtin_id {
            voice.id = uuid::Uuid::new_v4().to_string();
        }
        voice.builtin = false;
        if voice.category != VoiceCategory::Ai {
            voice.category = VoiceCategory::Custom;
            voice.ai_model_id = None;
        }
        match self.custom_voices.iter_mut().find(|v| v.id == voice.id) {
            Some(existing) => *existing = voice.clone(),
            None => self.custom_voices.push(voice.clone()),
        }
        self.save_voices()?;
        Ok(voice)
    }

    pub fn delete_voice(&mut self, id: &str) -> Result<(), StoreError> {
        if voxbox_dsp::builtin_presets().iter().any(|b| b.id == id) {
            return Err(StoreError::BuiltinVoice);
        }
        let before = self.custom_voices.len();
        self.custom_voices.retain(|v| v.id != id);
        if self.custom_voices.len() == before {
            return Err(StoreError::VoiceNotFound(id.into()));
        }
        self.hotkeys
            .retain(|h| h.action != HotkeyAction::Voice { id: id.into() });
        if self.settings.active_voice_id == id {
            self.settings.active_voice_id = AppSettings::default().active_voice_id;
            self.save_settings()?;
        }
        self.save_hotkeys()?;
        self.save_voices()
    }

    /// Removes every voice that runs the given AI model.
    pub fn forget_ai_model(&mut self, model_id: &str) -> Result<(), StoreError> {
        let ids: Vec<String> = self
            .custom_voices
            .iter()
            .filter(|v| v.ai_model_id.as_deref() == Some(model_id))
            .map(|v| v.id.clone())
            .chain(std::iter::once(ai_preset_id(model_id)))
            .collect();
        self.custom_voices.retain(|v| !ids.contains(&v.id));
        self.hotkeys
            .retain(|h| !matches!(&h.action, HotkeyAction::Voice { id } if ids.contains(id)));
        if ids.contains(&self.settings.active_voice_id) {
            self.settings.active_voice_id = AppSettings::default().active_voice_id;
            self.save_settings()?;
        }
        self.save_hotkeys()?;
        self.save_voices()
    }

    pub fn public_sounds(&self) -> Vec<Sound> {
        let mut out: Vec<Sound> = self.sounds.iter().map(|s| s.sound.clone()).collect();
        for s in &mut out {
            s.hotkey = self.hotkey_for(&HotkeyAction::Sound { id: s.id.clone() });
        }
        out
    }

    pub fn sound(&self, id: &str) -> Result<&StoredSound, StoreError> {
        self.sounds
            .iter()
            .find(|s| s.sound.id == id)
            .ok_or_else(|| StoreError::SoundNotFound(id.into()))
    }

    pub fn add_sound(&mut self, stored: StoredSound) -> Result<Sound, StoreError> {
        let sound = stored.sound.clone();
        self.sounds.push(stored);
        self.save_sounds()?;
        Ok(sound)
    }

    /// Updates name, category, favourite, volume and loop. `hotkey` is ignored:
    /// bindings only change through `set_hotkey`, so an edit carrying a stale
    /// hotkey can never steal back an accelerator moved to another action.
    pub fn update_sound(&mut self, sound: Sound) -> Result<Sound, StoreError> {
        if sound.name.trim().is_empty() {
            return Err(StoreError::EmptyName);
        }
        let action = HotkeyAction::Sound {
            id: sound.id.clone(),
        };
        let stored = self
            .sounds
            .iter_mut()
            .find(|s| s.sound.id == sound.id)
            .ok_or_else(|| StoreError::SoundNotFound(sound.id.clone()))?;
        stored.sound.name = sound.name.trim().to_string();
        stored.sound.category = sound
            .category
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.trim().to_string());
        stored.sound.favorite = sound.favorite;
        stored.sound.volume = sound.volume.clamp(0.0, 1.0);
        stored.sound.looped = sound.looped;
        stored.sound.hotkey = None;
        let mut out = stored.sound.clone();
        self.save_sounds()?;
        out.hotkey = self.hotkey_for(&action);
        Ok(out)
    }

    /// Removes the sound and returns its file path so the caller deletes it.
    pub fn delete_sound(&mut self, id: &str) -> Result<PathBuf, StoreError> {
        let pos = self
            .sounds
            .iter()
            .position(|s| s.sound.id == id)
            .ok_or_else(|| StoreError::SoundNotFound(id.into()))?;
        let removed = self.sounds.remove(pos);
        self.hotkeys
            .retain(|h| h.action != HotkeyAction::Sound { id: id.into() });
        self.save_hotkeys()?;
        self.save_sounds()?;
        Ok(self.sounds_dir().join(removed.file))
    }

    pub fn hotkey_for(&self, action: &HotkeyAction) -> Option<String> {
        self.hotkeys
            .iter()
            .find(|h| &h.action == action)
            .map(|h| h.accelerator.clone())
    }

    /// Binds (or with `None` unbinds) an action. An accelerator belongs to one
    /// action: binding it here moves it away from its previous owner, as the UI
    /// announces ("réassigné ici").
    pub fn set_hotkey(
        &mut self,
        action: HotkeyAction,
        accelerator: Option<String>,
    ) -> Result<(), StoreError> {
        if let Some(acc) = &accelerator {
            let parsed = parse_accelerator(acc).map_err(|e| StoreError::InvalidHotkey {
                accelerator: acc.clone(),
                reason: e.to_string(),
            })?;
            self.hotkeys
                .retain(|h| parse_accelerator(&h.accelerator).ok() != Some(parsed));
        }
        self.hotkeys.retain(|h| h.action != action);
        if let Some(acc) = accelerator {
            self.hotkeys.push(HotkeyBinding {
                action,
                accelerator: acc,
            });
        }
        self.save_hotkeys()
    }
}

pub fn ai_preset_id(model_id: &str) -> String {
    format!("ai-{model_id}")
}

pub fn ai_preset(m: &AiModelMeta) -> VoicePreset {
    VoicePreset {
        id: ai_preset_id(&m.id),
        name: m.name.clone(),
        description: String::from("IA · RVC"),
        icon: String::from("mic"),
        color: String::from("#7fe7ff"),
        category: VoiceCategory::Ai,
        effects: Vec::new(),
        ai_model_id: Some(m.id.clone()),
        builtin: m.builtin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sound(id: &str) -> StoredSound {
        StoredSound {
            sound: Sound {
                id: id.into(),
                name: "Vine boom".into(),
                category: None,
                favorite: false,
                volume: 1.0,
                looped: false,
                hotkey: None,
                duration_ms: 1200,
                source: SoundSource::Local,
                source_url: None,
            },
            file: format!("{id}.mp3"),
        }
    }

    fn model(id: &str) -> AiModelMeta {
        AiModelMeta {
            id: id.into(),
            name: "Narrateur".into(),
            model_sample_rate: 40000,
            has_index: true,
            builtin: false,
            license: None,
        }
    }

    #[test]
    fn persists_and_reloads_everything() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut s = Store::open(dir.path()).unwrap();
            s.settings.apply(SettingsPatch {
                monitor: Some(true),
                sound_mic_volume: Some(3.0),
                ..Default::default()
            });
            s.save_settings().unwrap();
            s.add_sound(sound("a")).unwrap();
            s.set_hotkey(HotkeyAction::Sound { id: "a".into() }, Some("F13".into()))
                .unwrap();
        }
        let s = Store::open(dir.path()).unwrap();
        assert!(s.settings.monitor);
        assert_eq!(s.settings.sound_mic_volume, 1.0, "clamped");
        assert_eq!(s.public_sounds()[0].hotkey.as_deref(), Some("F13"));
    }

    #[test]
    fn corrupt_file_is_kept_aside_and_defaults_used() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS), b"{not json").unwrap();
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.settings, AppSettings::default());
        assert!(dir.path().join("settings.json.corrupt").exists());
    }

    #[test]
    fn builtin_voices_cannot_be_overwritten_or_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let mut v = VoicePreset {
            id: "villager".into(),
            name: "Mon villageois".into(),
            description: String::new(),
            icon: "home".into(),
            color: "#ffffff".into(),
            category: VoiceCategory::Fun,
            effects: Vec::new(),
            ai_model_id: None,
            builtin: true,
        };
        let saved = s.save_voice(v.clone()).unwrap();
        assert_ne!(saved.id, "villager", "duplicating a built-in gets a new id");
        assert_eq!(saved.category, VoiceCategory::Custom);
        assert!(!saved.builtin);
        assert!(matches!(
            s.delete_voice("villager"),
            Err(StoreError::BuiltinVoice) | Err(StoreError::VoiceNotFound(_))
        ));
        v.name = "  ".into();
        assert!(matches!(s.save_voice(v), Err(StoreError::EmptyName)));
    }

    #[test]
    fn deleting_active_custom_voice_resets_active_and_hotkey() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let v = s
            .save_voice(VoicePreset {
                id: String::new(),
                name: "Perso".into(),
                description: String::new(),
                icon: "wrench".into(),
                color: "#ffffff".into(),
                category: VoiceCategory::Custom,
                effects: Vec::new(),
                ai_model_id: None,
                builtin: false,
            })
            .unwrap();
        s.settings.active_voice_id = v.id.clone();
        s.set_hotkey(HotkeyAction::Voice { id: v.id.clone() }, Some("F20".into()))
            .unwrap();
        s.delete_voice(&v.id).unwrap();
        assert_eq!(s.settings.active_voice_id, "villager");
        assert!(s.hotkey_for(&HotkeyAction::Voice { id: v.id }).is_none());
    }

    #[test]
    fn ai_models_appear_as_voices_and_are_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let models = vec![model("m1")];
        let v = s.find_voice("ai-m1", &models).expect("AI voice listed");
        assert_eq!(v.ai_model_id.as_deref(), Some("m1"));
        s.settings.active_voice_id = "ai-m1".into();
        s.forget_ai_model("m1").unwrap();
        assert_eq!(s.settings.active_voice_id, "villager");
    }

    #[test]
    fn hotkeys_are_validated_and_reassigned() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        assert!(matches!(
            s.set_hotkey(HotkeyAction::StopAllSounds, Some("Ctrl+Nope".into())),
            Err(StoreError::InvalidHotkey { .. })
        ));
        assert_eq!(
            s.hotkey_for(&HotkeyAction::StopAllSounds).as_deref(),
            Some("Ctrl+Alt+S"),
            "invalid input leaves the binding untouched"
        );
        // Ctrl+Alt+V belongs to ToggleVoice by default; the same chord spelled differently moves it.
        s.set_hotkey(HotkeyAction::StopAllSounds, Some("alt+ctrl+v".into()))
            .unwrap();
        assert_eq!(
            s.hotkey_for(&HotkeyAction::StopAllSounds).as_deref(),
            Some("alt+ctrl+v")
        );
        assert!(
            s.hotkey_for(&HotkeyAction::ToggleVoice).is_none(),
            "previous owner unbound"
        );
        assert_eq!(
            s.hotkeys
                .iter()
                .filter(|h| h.accelerator.eq_ignore_ascii_case("alt+ctrl+v"))
                .count(),
            1
        );
        let reloaded = Store::open(dir.path()).unwrap();
        assert!(
            reloaded.hotkey_for(&HotkeyAction::ToggleVoice).is_none(),
            "persisted"
        );
    }

    #[test]
    fn sound_update_clamps_and_delete_returns_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        s.add_sound(sound("a")).unwrap();
        let mut edit = s.public_sounds()[0].clone();
        edit.volume = 2.0;
        edit.category = Some("  ".into());
        edit.hotkey = Some("F14".into());
        let out = s.update_sound(edit).unwrap();
        assert_eq!(out.volume, 1.0);
        assert_eq!(out.category, None);
        let file = s.delete_sound("a").unwrap();
        assert_eq!(file, dir.path().join("sounds").join("a.mp3"));
        assert!(s
            .hotkey_for(&HotkeyAction::Sound { id: "a".into() })
            .is_none());
        assert!(matches!(
            s.delete_sound("a"),
            Err(StoreError::SoundNotFound(_))
        ));
    }

    #[test]
    fn editing_a_sound_never_steals_back_a_reassigned_hotkey() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        s.add_sound(sound("a")).unwrap();
        s.add_sound(sound("b")).unwrap();
        s.set_hotkey(HotkeyAction::Sound { id: "a".into() }, Some("F13".into()))
            .unwrap();
        let mut a = s.public_sounds()[0].clone();
        assert_eq!(a.hotkey.as_deref(), Some("F13"));
        // F13 moves to sound B; A's copy in the UI still says F13.
        s.set_hotkey(HotkeyAction::Sound { id: "b".into() }, Some("F13".into()))
            .unwrap();
        a.favorite = true;
        let out = s.update_sound(a).unwrap();
        assert!(out.favorite);
        assert_eq!(out.hotkey, None, "A reports its real (now empty) binding");
        assert_eq!(
            s.hotkey_for(&HotkeyAction::Sound { id: "b".into() })
                .as_deref(),
            Some("F13")
        );
        assert!(s
            .hotkey_for(&HotkeyAction::Sound { id: "a".into() })
            .is_none());
        let public = s.public_sounds();
        assert_eq!(
            public
                .iter()
                .find(|x| x.id == "b")
                .unwrap()
                .hotkey
                .as_deref(),
            Some("F13")
        );
    }

    #[test]
    fn unplugged_devices_fall_back_to_defaults_together() {
        let info = |id: &str| voxbox_engine::DeviceInfo {
            id: id.into(),
            name: id.into(),
            is_default: false,
            is_cable: false,
        };
        let available = Devices {
            inputs: vec![info("mic")],
            outputs: vec![info("speakers"), info("CABLE Input")],
        };
        let saved = DeviceSelection {
            input: Some("usb-headset".into()),
            cable: Some("CABLE Input".into()),
            monitor: Some("usb-headset".into()),
        };
        assert_eq!(
            sanitize_devices(saved, &available),
            DeviceSelection {
                input: None,
                cable: Some("CABLE Input".into()),
                monitor: None
            }
        );
        let ok = DeviceSelection {
            input: Some("mic".into()),
            cable: None,
            monitor: Some("speakers".into()),
        };
        assert_eq!(sanitize_devices(ok.clone(), &available), ok);
    }

    fn devices(monitor: &str) -> DeviceSelection {
        DeviceSelection {
            input: Some("mic".into()),
            cable: None,
            monitor: Some(monitor.into()),
        }
    }

    /// Store whose next save fails while settings.json keeps its saved content:
    /// the temporary file path is taken by a non-empty directory.
    fn store_with_failing_save(dir: &Path, current: DeviceSelection) -> Store {
        let mut s = Store::open(dir).unwrap();
        let mut next = s.settings.clone();
        next.devices = current;
        s.commit_settings(next, true, |_| Ok::<(), StoreError>(()))
            .unwrap();
        let tmp = dir.join(SETTINGS).with_extension("json.tmp");
        fs::create_dir(&tmp).unwrap();
        fs::write(tmp.join("keep"), b"x").unwrap();
        s
    }

    fn saved(dir: &Path) -> AppSettings {
        serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS)).unwrap()).unwrap()
    }

    #[test]
    fn rejected_device_switch_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let mut next = s.settings.clone();
        next.devices = devices("speakers");
        s.commit_settings(next, true, |_| Ok::<(), StoreError>(()))
            .unwrap();

        let mut next = s.settings.clone();
        next.devices = devices("same-as-cable");
        next.monitor = true;
        let result = s.commit_settings(next, true, |_| Err(StoreError::Other("refusé".into())));
        assert!(result.is_err());
        assert_eq!(
            s.settings.devices,
            devices("speakers"),
            "memory: previous devices"
        );
        assert!(
            !s.settings.monitor,
            "the rest of the patch is not applied either"
        );
        assert_eq!(
            saved(dir.path()).devices,
            devices("speakers"),
            "disk: previous devices"
        );
    }

    #[test]
    fn failed_save_reopens_previous_devices() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store_with_failing_save(dir.path(), devices("speakers"));
        let mut next = s.settings.clone();
        next.devices = devices("headset");
        next.monitor = true;
        let mut opened = Vec::new();
        let result = s.commit_settings(next, true, |d| {
            opened.push(d.clone());
            Ok::<(), StoreError>(())
        });
        assert!(matches!(result, Err(StoreError::Write { .. })));
        assert_eq!(opened, vec![devices("headset"), devices("speakers")]);
        assert_eq!(s.settings.devices, devices("speakers"));
        assert!(!s.settings.monitor);
        let on_disk = saved(dir.path());
        assert_eq!(
            on_disk.devices,
            devices("speakers"),
            "disk keeps the saved devices"
        );
        assert!(!on_disk.monitor);
    }

    #[test]
    fn failed_save_and_failed_reopen_reports_both_causes_without_guessing() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store_with_failing_save(dir.path(), devices("speakers"));
        let mut next = s.settings.clone();
        next.devices = devices("headset");
        next.monitor = true;
        let mut calls = 0;
        let result = s.commit_settings(next, true, |_| {
            calls += 1;
            if calls == 1 {
                Ok(())
            } else {
                Err(StoreError::Other("flux impossible".into()))
            }
        });
        let Err(StoreError::DevicesNotRestored { save, reopen }) = result else {
            panic!("expected DevicesNotRestored");
        };
        assert!(save.contains("impossible d'enregistrer"), "{save}");
        assert_eq!(reopen, "flux impossible");
        let message = StoreError::DevicesNotRestored { save, reopen }.to_string();
        assert!(
            !message.contains("actifs"),
            "no claim about what is running: {message}"
        );
        assert_eq!(
            s.settings.devices,
            devices("speakers"),
            "memory matches disk"
        );
        assert_eq!(saved(dir.path()).devices, devices("speakers"));
    }

    #[test]
    fn settings_without_device_change_do_not_touch_the_engine() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store_with_failing_save(dir.path(), devices("speakers"));
        let mut next = s.settings.clone();
        next.monitor = true;
        let result = s.commit_settings(next, false, |_| -> Result<(), StoreError> {
            panic!("engine must not be called")
        });
        assert!(matches!(result, Err(StoreError::Write { .. })));
        assert!(!s.settings.monitor);
        assert!(!saved(dir.path()).monitor);
    }

    /// The store lock is still held while the engine receives the new values, so
    /// a concurrent change can only commit after that publication completes.
    #[test]
    fn publication_to_the_engine_happens_under_the_store_lock() {
        use std::sync::mpsc;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(parking_lot::Mutex::new(Store::open(dir.path()).unwrap()));
        let published = Arc::new(parking_lot::Mutex::new(Vec::<(char, bool)>::new()));
        let (publishing_tx, publishing_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();

        // A: an unrelated change (monitor) while ptt_mode is still false, paused inside publish.
        let a = {
            let (store, published) = (store.clone(), published.clone());
            std::thread::spawn(move || {
                commit_and_publish(
                    &store,
                    |s| s.monitor = true,
                    None,
                    |_| Ok::<(), StoreError>(()),
                    |s| {
                        publishing_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        published.lock().push(('A', s.ptt_mode));
                    },
                )
                .unwrap();
            })
        };
        publishing_rx.recv().unwrap();
        assert!(
            store.try_lock().is_none(),
            "a concurrent change cannot commit while A publishes"
        );
        release_tx.send(()).unwrap();
        a.join().unwrap();

        // B: enables push-to-talk; it can only run once A has published.
        commit_and_publish(
            &store,
            |s| s.ptt_mode = true,
            None,
            |_| Ok::<(), StoreError>(()),
            |s| {
                published.lock().push(('B', s.ptt_mode));
            },
        )
        .unwrap();
        assert_eq!(
            *published.lock(),
            vec![('A', false), ('B', true)],
            "engine ends on the saved value"
        );
        let settings = store.lock().settings.clone();
        assert!(settings.ptt_mode && settings.monitor);
    }

    /// Same cases as ui/src/lib/rvcParams.test.ts.
    #[test]
    fn ai_params_use_the_ui_limits() {
        let p = |pitch, index, block, fade| RvcParams {
            pitch_semitones: pitch,
            index_rate: index,
            block_ms: block,
            crossfade_ms: fade,
        };
        assert_eq!(clamp_ai_params(p(30.0, 2.0, 40, 0)), p(12.0, 1.0, 100, 10));
        assert_eq!(
            clamp_ai_params(p(-30.0, -1.0, 5000, 900)),
            p(-12.0, 0.0, 1000, 200)
        );
        assert_eq!(
            clamp_ai_params(p(0.0, 0.5, 255, 127)),
            p(0.0, 0.5, 250, 120)
        );
        assert_eq!(
            clamp_ai_params(p(f32::NAN, f32::NAN, 250, 50)),
            p(0.0, 0.0, 250, 50)
        );
    }

    #[test]
    fn sound_json_uses_loop_key() {
        let json = serde_json::to_value(&sound("a").sound).unwrap();
        assert_eq!(json["loop"], false);
        assert_eq!(json["durationMs"], 1200);
        assert_eq!(json["source"], "local");
    }
}
