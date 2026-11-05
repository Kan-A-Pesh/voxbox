//! Application state shared by commands, hotkeys and the tray.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use voxbox_dsp::{EffectDescriptor, EffectSpec, VoicePreset};
use voxbox_engine::{DecodedSound, Engine, EngineEvent, EngineStatus};
use voxbox_rvc::{AiModelMeta, BackendInfo, RvcRuntime, RvcStream};

use crate::hotkeys::{HotkeyAction, HotkeyBinding, HotkeyEvent, Matcher};
use crate::store::{AppSettings, Sound, Store};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: AppSettings,
    pub status: EngineStatus,
    pub voices: Vec<VoicePreset>,
    pub effect_catalog: Vec<EffectDescriptor>,
    pub sounds: Vec<Sound>,
    pub hotkeys: Vec<HotkeyBinding>,
    pub ai_models: Vec<AiModelMeta>,
    pub ai_backend: BackendInfo,
}

/// Paths of files shipped by the installers (`resources/` next to the exe). The
/// `rvc-*` and `converter` folders come from the optional "Voix IA" pack
/// (scripts/build_ai_pack.ps1).
#[derive(Debug, Clone)]
pub struct Resources {
    /// ContentVec + RMVPE ONNX files and the ONNX Runtime / DirectML DLLs.
    pub ai_assets: PathBuf,
    /// AI voices shipped with VoxBox (same layout as the user models dir).
    pub ai_voices: PathBuf,
    pub python_exe: PathBuf,
    pub converter_script: PathBuf,
}

impl Resources {
    pub fn from_dir(dir: &Path) -> Self {
        let converter = dir.join("converter");
        Self {
            ai_assets: dir.join("rvc-assets"),
            ai_voices: dir.join("rvc-voices"),
            python_exe: converter.join("python.exe"),
            converter_script: converter.join("convert_rvc.py"),
        }
    }
}

pub struct AppState {
    app: AppHandle,
    pub store: Mutex<Store>,
    pub engine: Engine,
    pub rvc: Option<RvcRuntime>,
    pub backend: BackendInfo,
    pub resources: Resources,
    pub matcher: Arc<Mutex<Matcher>>,
    sound_cache: Mutex<HashMap<String, DecodedSound>>,
    /// Serializes `apply_voice`: a slow AI model load can never install an older
    /// selection over a newer one.
    voice_lock: Mutex<()>,
    /// Editor preview overrides the active voice while set.
    preview: Mutex<Option<Vec<EffectSpec>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
    #[error(transparent)]
    Engine(#[from] voxbox_engine::EngineError),
    #[error(transparent)]
    Rvc(#[from] voxbox_rvc::RvcError),
    #[error(transparent)]
    MyInstants(#[from] voxbox_myinstants::MyInstantsError),
    #[error("{0}")]
    Other(String),
}

// Commands return errors to the UI as plain French messages.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl AppState {
    pub fn new(
        app: AppHandle,
        store: Store,
        engine: Engine,
        rvc: Option<RvcRuntime>,
        backend: BackendInfo,
        resources: Resources,
    ) -> Self {
        let matcher = Arc::new(Mutex::new(Matcher::new(&store.hotkeys)));
        Self {
            app,
            store: Mutex::new(store),
            engine,
            rvc,
            backend,
            resources,
            matcher,
            sound_cache: Mutex::new(HashMap::new()),
            preview: Mutex::new(None),
            voice_lock: Mutex::new(()),
        }
    }

    /// Bundled voices first, then user imports.
    pub fn ai_models(&self) -> Vec<AiModelMeta> {
        let models_dir = self.store.lock().models_dir();
        let mut out = Vec::new();
        for (dir, builtin) in [(&self.resources.ai_voices, true), (&models_dir, false)] {
            match voxbox_rvc::list_models(dir) {
                Ok(models) => out.extend(models.into_iter().map(|mut m| {
                    m.builtin = builtin;
                    m
                })),
                Err(e) => tracing::warn!("modèles IA illisibles dans {} : {e}", dir.display()),
            }
        }
        out
    }

    pub fn model_dir(&self, model: &AiModelMeta) -> PathBuf {
        if model.builtin {
            self.resources.ai_voices.join(&model.id)
        } else {
            self.store.lock().models_dir().join(&model.id)
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let ai_models = self.ai_models();
        let store = self.store.lock();
        Snapshot {
            settings: store.settings.clone(),
            status: self.engine.status(),
            voices: store.voices(&ai_models),
            effect_catalog: voxbox_dsp::effect_catalog(),
            sounds: store.public_sounds(),
            hotkeys: store.hotkeys.clone(),
            ai_models,
            ai_backend: self.backend.clone(),
        }
    }

    /// Pushes every setting to the engine (startup and device changes).
    pub fn apply_all(&self) -> AppResult<()> {
        {
            let store = self.store.lock();
            self.publish_flags(&store.settings);
        }
        self.apply_voice()
    }

    /// Engine switches mirrored from the settings. Called with the store lock
    /// held (see `store::commit_and_publish`) so the engine never ends up on an
    /// older value than the one saved.
    pub fn publish_flags(&self, s: &AppSettings) {
        self.engine.set_voice_enabled(s.voice_enabled);
        self.engine.set_monitor(s.monitor);
        self.engine.set_noise_suppression(s.noise_suppression);
        self.engine.set_ptt_mode(s.ptt_mode);
        self.engine
            .set_sound_bus(s.sound_mic_volume, s.sound_monitor_volume);
    }

    /// Applies a settings change from a hotkey or the tray (no device change).
    fn change_settings(&self, change: impl FnOnce(&mut AppSettings)) -> AppResult<AppSettings> {
        crate::store::commit_and_publish(
            &self.store,
            change,
            None,
            |_| Ok::<(), AppError>(()),
            |s| self.publish_flags(s),
        )
    }

    /// Loads the active voice (or the editor preview) into the engine.
    pub fn apply_voice(&self) -> AppResult<()> {
        // Held from reading the selection to installing it in the engine.
        let _applying = self.voice_lock.lock();
        if let Some(effects) = self.preview.lock().clone() {
            self.engine.set_voice(&effects, None);
            return Ok(());
        }
        let ai_models = self.ai_models();
        let (voice, params) = {
            let store = self.store.lock();
            let id = store.settings.active_voice_id.clone();
            let voice = store
                .find_voice(&id, &ai_models)
                .or_else(|| store.find_voice(&AppSettings::default().active_voice_id, &ai_models));
            (voice, store.settings.ai_params)
        };
        let Some(voice) = voice else {
            self.engine.set_voice(&[], None);
            return Ok(());
        };
        let ai = match &voice.ai_model_id {
            Some(model_id) => {
                let model = ai_models
                    .iter()
                    .find(|m| &m.id == model_id)
                    .ok_or_else(|| {
                        AppError::Other(format!("modèle IA introuvable : {model_id}"))
                    })?;
                let runtime = self.rvc.as_ref().ok_or_else(|| {
                    AppError::Other(String::from("les voix IA ne sont pas installées (installez le pack « VoxBox - Voix IA »)"))
                })?;
                let app = self.app.clone();
                let name = voice.name.clone();
                let on_error: voxbox_rvc::ErrorHandler = Box::new(move |reason| {
                    let message = format!(
                        "La voix IA « {name} » s'est arrêtée ({reason}). Resélectionne-la pour la relancer, ou choisis une autre voix."
                    );
                    if let Err(e) = app.emit("engine", EngineEvent::DeviceError { message }) {
                        tracing::warn!("erreur de voix IA non transmise : {e}");
                    }
                });
                Some(RvcStream::start(
                    runtime,
                    &self.model_dir(model),
                    params,
                    on_error,
                )?)
            }
            None => None,
        };
        self.engine.set_voice(&voice.effects, ai);
        Ok(())
    }

    pub fn set_preview(&self, effects: Option<Vec<EffectSpec>>) -> AppResult<()> {
        *self.preview.lock() = effects;
        self.apply_voice()
    }

    pub fn play_sound(&self, id: &str) -> AppResult<()> {
        let (path, volume, looped) = {
            let store = self.store.lock();
            let s = store.sound(id)?;
            (
                store.sounds_dir().join(&s.file),
                s.sound.volume,
                s.sound.looped,
            )
        };
        let cached = self.sound_cache.lock().get(id).cloned();
        let decoded = match cached {
            Some(d) => d,
            None => {
                let d = voxbox_engine::decode_file(&path)?;
                self.sound_cache.lock().insert(id.to_string(), d.clone());
                d
            }
        };
        self.engine.play_sound(id, decoded, volume, looped);
        Ok(())
    }

    pub fn forget_sound(&self, id: &str) {
        self.sound_cache.lock().remove(id);
        self.engine.stop_sound(id);
    }

    pub fn refresh_hotkeys(&self) {
        let bindings = self.store.lock().hotkeys.clone();
        self.matcher.lock().set_bindings(&bindings);
    }

    /// Applies a global hotkey. Returns true when visible state changed.
    pub fn handle_hotkey(&self, event: HotkeyEvent) -> AppResult<bool> {
        match event {
            HotkeyEvent::Pressed(HotkeyAction::PushToTalk) => {
                self.engine.set_ptt_pressed(true);
                Ok(false)
            }
            HotkeyEvent::Released(HotkeyAction::PushToTalk) => {
                self.engine.set_ptt_pressed(false);
                Ok(false)
            }
            HotkeyEvent::Released(_) => Ok(false),
            HotkeyEvent::Pressed(HotkeyAction::Sound { id }) => {
                self.play_sound(&id)?;
                Ok(false)
            }
            HotkeyEvent::Pressed(HotkeyAction::StopAllSounds) => {
                self.engine.stop_all_sounds();
                Ok(false)
            }
            HotkeyEvent::Pressed(HotkeyAction::ToggleVoice) => {
                self.change_settings(|s| s.voice_enabled = !s.voice_enabled)?;
                Ok(true)
            }
            HotkeyEvent::Pressed(HotkeyAction::ToggleMonitor) => {
                self.change_settings(|s| s.monitor = !s.monitor)?;
                Ok(true)
            }
            HotkeyEvent::Pressed(HotkeyAction::Voice { id }) => {
                self.change_settings(|s| {
                    s.active_voice_id = id;
                    s.voice_enabled = true;
                })?;
                self.apply_voice()?;
                Ok(true)
            }
        }
    }

    pub fn emit_snapshot(&self, app: &AppHandle) {
        if let Err(e) = app.emit("snapshot-changed", self.snapshot()) {
            tracing::warn!("événement snapshot-changed non envoyé : {e}");
        }
    }
}
