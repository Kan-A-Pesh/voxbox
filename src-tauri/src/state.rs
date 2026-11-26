//! Application state shared by commands, hotkeys and the tray.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use voxbox_dsp::{EffectDescriptor, EffectSpec, VoicePreset};
use voxbox_engine::{DecodedSound, Engine, EngineEvent, EngineStatus};
use voxbox_rvc::{AiModelMeta, BackendInfo, RvcRuntime, RvcStream};

use crate::hotkeys::{HotkeyAction, HotkeyBinding, HotkeyEvent, Matcher};
use crate::store::{AppSettings, Sound, Store};

/// Level of a MyInstants sound played before it is in the bank (bank sounds have their own).
const REMOTE_VOLUME: f32 = 0.8;
/// Decoded MyInstants sounds kept in memory for replays; older ones are dropped.
const REMOTE_CACHE: usize = 16;
const REMOTE_PREFIX: &str = "myinstants:";
const ENGINE_STOPPED: &str = "le moteur audio est arrêté : redémarre VoxBox";

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

/// Sound plays the app accepted but has not started yet (a MyInstants download,
/// a first decode). A "stop all" or a stop of that id cancels them; starting one
/// and stopping run under one lock, so the engine never gets a cancelled play
/// after the stop that cancelled it.
///
/// Order between clicks comes from the commands themselves: the UI sends them in
/// click order, and accepting a play, stopping a sound and stopping all are
/// synchronous commands, run one at a time on the main thread in that order.
#[derive(Default)]
struct PlaybackGate {
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    /// The admission waiting to start, per playback id (a bank sound replayed
    /// keeps its id: only its latest admission may start).
    by_id: HashMap<String, u64>,
    last: u64,
    /// How many times the "stop all" shortcut ran (see [`AppState::hotkey_stops`]).
    hotkey_stops: u64,
}

/// One accepted play: only this admission may start it or report its failure.
struct Admission {
    id: String,
    token: u64,
}

impl PlaybackGate {
    /// Accepts a play of `id`. `stops`: the shortcut's stop count known when the
    /// play was clicked (None for a play that is not a UI click, e.g. a hotkey):
    /// a play clicked before a shortcut stop is refused (None). Checked under the
    /// same lock the shortcut stop takes, so the two can never interleave.
    fn admit(&self, id: &str, stops: Option<u64>) -> Option<Admission> {
        let mut pending = self.pending.lock();
        if stops.is_some_and(|stops| stops < pending.hotkey_stops) {
            return None;
        }
        pending.last += 1;
        let token = pending.last;
        pending.by_id.insert(id.to_string(), token);
        Some(Admission {
            id: id.to_string(),
            token,
        })
    }

    fn hotkey_stops(&self) -> u64 {
        self.pending.lock().hotkey_stops
    }

    /// The shortcut's "stop all": counts it, then stops like [`Self::stop_all`].
    /// Returns the new count and the plays that had not started.
    fn stop_all_from_hotkey(&self, send_stop: impl FnOnce()) -> (u64, Vec<String>) {
        let mut pending = self.pending.lock();
        pending.hotkey_stops += 1;
        send_stop();
        let cancelled = pending.by_id.drain().map(|(id, _)| id).collect();
        (pending.hotkey_stops, cancelled)
    }

    /// Takes `admission` out if it is still the one waiting (not stopped, not replaced).
    fn take(pending: &mut Pending, admission: &Admission) -> bool {
        if pending.by_id.get(&admission.id) != Some(&admission.token) {
            return false;
        }
        pending.by_id.remove(&admission.id);
        true
    }

    /// Runs `send_play` and returns true only if `admission` is still waiting to start.
    fn start(&self, admission: &Admission, send_play: impl FnOnce()) -> bool {
        let mut pending = self.pending.lock();
        if !Self::take(&mut pending, admission) {
            return false;
        }
        send_play();
        true
    }

    /// Drops a failed `admission`; true if it was still waiting (its end is due).
    fn fail(&self, admission: &Admission) -> bool {
        Self::take(&mut self.pending.lock(), admission)
    }

    /// Returns true when `id` had not started (it never will).
    fn stop(&self, id: &str, send_stop: impl FnOnce()) -> bool {
        let mut pending = self.pending.lock();
        let cancelled = pending.by_id.remove(id).is_some();
        send_stop();
        cancelled
    }

    /// Returns the plays that had not started (they never will).
    fn stop_all(&self, send_stop: impl FnOnce()) -> Vec<String> {
        let mut pending = self.pending.lock();
        send_stop();
        pending.by_id.drain().map(|(id, _)| id).collect()
    }
}

/// Cache key of a MyInstants sound; its playback ids are `<key>#<unique>`.
pub fn remote_key(sound: &voxbox_myinstants::RemoteSound) -> String {
    format!("{REMOTE_PREFIX}{}", sound.mp3_url)
}

/// Runs once a sound is loaded (or failed to): starts an admitted play.
type LoadWaiter = Box<dyn FnOnce(&AppState, Result<DecodedSound, String>) + Send>;

/// Payload of the `sound-failed` event: a play the app accepted could not start.
#[derive(Clone, Serialize)]
pub struct SoundFailed {
    pub id: String,
    pub message: String,
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
    /// Plays accepted but not started yet (download, first decode).
    sound_gate: PlaybackGate,
    /// Downloads and decodes in progress, by cache key, with what waits for them:
    /// replaying a sound still loading never starts a second load.
    loads: Mutex<HashMap<String, Vec<LoadWaiter>>>,
    /// The UI page allowed to play and stop sounds (see [`Self::start_page`]).
    page: std::sync::atomic::AtomicU64,
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
    #[error(transparent)]
    VoiceModels(#[from] voxbox_voicemodels::VoiceModelsError),
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
            sound_gate: PlaybackGate::default(),
            loads: Mutex::new(HashMap::new()),
            page: std::sync::atomic::AtomicU64::new(0),
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
                    tracing::error!("{message}");
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

    /// Plays a sound of the bank. A sound not decoded yet starts once decoded,
    /// unless stopped meanwhile; a decoding failure arrives as `sound-failed`.
    /// `stops`: see [`Self::hotkey_stops`] (None for the sound's own hotkey).
    pub fn play_sound(&self, id: &str, stops: Option<u64>) -> AppResult<()> {
        let (path, volume, looped) = {
            let store = self.store.lock();
            let s = store.sound(id)?;
            (
                store.sounds_dir().join(&s.file),
                s.sound.volume,
                s.sound.looped,
            )
        };
        let Some(admission) = self.sound_gate.admit(id, stops) else {
            // Clicked before the shortcut stopped everything: it just ends.
            self.emit_ended(id);
            return Ok(());
        };
        let start = move |state: &AppState, decoded: Result<DecodedSound, String>| match decoded {
            Ok(decoded) => {
                let mut sent = true;
                let started = state.sound_gate.start(&admission, || {
                    sent = state
                        .engine
                        .play_sound(&admission.id, decoded, volume, looped);
                });
                if started && !sent {
                    state.report_failed(&admission.id, ENGINE_STOPPED);
                }
            }
            Err(message) => state.sound_failed(&admission, &message),
        };
        let cached = self.sound_cache.lock().get(id).cloned();
        match cached {
            Some(decoded) => start(self, Ok(decoded)),
            None => {
                let key = id.to_string();
                self.load_then(key.clone(), Box::new(start), move |state| {
                    let decoded = voxbox_engine::decode_file(&path).map_err(|e| e.to_string())?;
                    state.sound_cache.lock().insert(key, decoded.clone());
                    Ok(decoded)
                });
            }
        }
        Ok(())
    }

    /// Loads `key` on its own thread (once, whoever else waits for it) then runs
    /// `waiter` with the result.
    fn load_then(
        &self,
        key: String,
        waiter: LoadWaiter,
        load: impl FnOnce(&AppState) -> Result<DecodedSound, String> + Send + 'static,
    ) {
        {
            let mut loads = self.loads.lock();
            if let Some(waiting) = loads.get_mut(&key) {
                waiting.push(waiter);
                return;
            }
            loads.insert(key.clone(), vec![waiter]);
        }
        let app = self.app.clone();
        let loaded_key = key.clone();
        let spawned = std::thread::Builder::new()
            .name(String::from("voxbox-sound-load"))
            .spawn(move || {
                let state = app.state::<AppState>();
                let result = load(&state);
                state.finish_load(&loaded_key, &result);
            });
        if let Err(e) = spawned {
            self.finish_load(&key, &Err(format!("chargement du son impossible : {e}")));
        }
    }

    fn finish_load(&self, key: &str, result: &Result<DecodedSound, String>) {
        let waiters = self.loads.lock().remove(key).unwrap_or_default();
        for waiter in waiters {
            waiter(self, result.clone());
        }
    }

    /// A play the app accepted could not start: the UI hears it ended, and why.
    /// Nothing is reported when a newer play or a stop replaced it meanwhile.
    fn sound_failed(&self, admission: &Admission, message: &str) {
        let id = admission.id.as_str();
        if !self.sound_gate.fail(admission) {
            tracing::warn!("son « {id} » non joué (déjà arrêté ou relancé) : {message}");
            return;
        }
        self.report_failed(id, message);
    }

    /// Tells the UI a play ended without playing, and why (logged).
    fn report_failed(&self, id: &str, message: &str) {
        tracing::error!("son « {id} » non joué : {message}");
        self.emit_ended(id);
        let failed = SoundFailed {
            id: id.to_string(),
            message: message.to_string(),
        };
        if let Err(e) = self.app.emit("sound-failed", failed) {
            tracing::warn!("échec du son non transmis : {e}");
        }
    }

    /// A play cancelled before it started ends for the UI too (the engine never had it).
    fn emit_ended(&self, id: &str) {
        let ended = EngineEvent::SoundEnded { id: id.to_string() };
        if let Err(e) = self.app.emit("engine", ended) {
            tracing::warn!("fin du son non transmise : {e}");
        }
    }

    /// Stops a sound, or cancels it if it has not started yet.
    pub fn stop_sound(&self, id: &str) {
        if self.sound_gate.stop(id, || self.engine.stop_sound(id)) {
            self.emit_ended(id);
        }
    }

    /// The webview starts loading a page (a reload, a navigation): from now on only
    /// the new page's sound commands count, and the previous page's sounds stop.
    /// Driven by the webview itself, so a late request of the old page cannot
    /// reorder it.
    pub fn start_page(&self) {
        self.page.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.stop_all_sounds();
    }

    /// The number of the page loaded now, for its sound commands.
    pub fn current_page(&self) -> u64 {
        self.page.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// How many times the "stop all" shortcut ran. The UI sends with each play
    /// the count it knew when the play was clicked: a play clicked before a
    /// shortcut press (still queued or on its way) is then refused, and just ends.
    pub fn hotkey_stops(&self) -> u64 {
        self.sound_gate.hotkey_stops()
    }

    /// The "stop all" shortcut: stops everything, and tells the UI (`sounds-stopped`).
    pub fn stop_all_from_hotkey(&self) {
        let (stops, cancelled) = self
            .sound_gate
            .stop_all_from_hotkey(|| self.engine.stop_all_sounds());
        for id in cancelled {
            self.emit_ended(&id);
        }
        if let Err(e) = self.app.emit("sounds-stopped", stops) {
            tracing::warn!("arrêt des sons non transmis : {e}");
        }
    }

    /// False for a command sent by a page since reloaded (it arrived late).
    pub fn is_current_page(&self, page: u64) -> bool {
        let current = self.page.load(std::sync::atomic::Ordering::SeqCst) == page;
        if !current {
            tracing::warn!("commande de son d'une page rechargée depuis, ignorée");
        }
        current
    }

    /// Stops every sound, including the ones still downloading or decoding.
    pub fn stop_all_sounds(&self) {
        for id in self.sound_gate.stop_all(|| self.engine.stop_all_sounds()) {
            self.emit_ended(&id);
        }
    }

    /// Downloads a MyInstants sound into a temporary folder of the sound bank, runs
    /// `use_file` on it, then removes the folder (whatever `use_file` returned).
    pub fn with_myinstants_file<T>(
        &self,
        sound: &voxbox_myinstants::RemoteSound,
        use_file: impl FnOnce(&Path) -> AppResult<T>,
    ) -> AppResult<T> {
        let parent = self.store.lock().sounds_dir();
        with_download_dir(&parent, |tmp| {
            voxbox_myinstants::Client::new()
                .download(sound, tmp)
                .map_err(AppError::from)
                .and_then(|path| use_file(&path))
        })
    }

    /// Plays a MyInstants sound without adding it to the bank: to everyone (mic +
    /// headset) or, for a preview, in the headset only. Decoded once per session.
    /// Returns at once a playback id unique to this request (for stop and progress
    /// events), so stopping an older request never stops a newer play of the same
    /// sound. The sound starts once downloaded unless stopped meanwhile; a failure
    /// arrives as `sound-failed`.
    pub fn play_remote(
        &self,
        sound: &voxbox_myinstants::RemoteSound,
        preview: bool,
        stops: u64,
    ) -> String {
        let key = remote_key(sound);
        let id = format!("{key}#{}", uuid::Uuid::new_v4());
        let Some(admission) = self.sound_gate.admit(&id, Some(stops)) else {
            // Clicked before the shortcut stopped everything: it just ends.
            self.emit_ended(&id);
            return id;
        };
        let start = move |state: &AppState, decoded: Result<DecodedSound, String>| {
            let decoded = match decoded {
                Ok(decoded) => decoded,
                Err(message) => return state.sound_failed(&admission, &message),
            };
            let id = admission.id.as_str();
            let mut sent = true;
            let started = state.sound_gate.start(&admission, || {
                sent = if preview {
                    state.engine.preview_sound(id, decoded, REMOTE_VOLUME)
                } else {
                    state.engine.play_sound(id, decoded, REMOTE_VOLUME, false)
                };
            });
            if started && !sent {
                state.report_failed(id, ENGINE_STOPPED);
            }
        };
        let cached = self.sound_cache.lock().get(&key).cloned();
        match cached {
            Some(decoded) => start(self, Ok(decoded)),
            None => {
                let sound = sound.clone();
                self.load_then(key.clone(), Box::new(start), move |state| {
                    let decoded = state
                        .with_myinstants_file(&sound, |path| Ok(voxbox_engine::decode_file(path)?))
                        .map_err(|e| e.to_string())?;
                    state.cache_remote(key, decoded.clone());
                    Ok(decoded)
                });
            }
        }
        id
    }

    fn cache_remote(&self, key: String, decoded: DecodedSound) {
        let mut cache = self.sound_cache.lock();
        let remote: Vec<String> = cache
            .keys()
            .filter(|k| k.starts_with(REMOTE_PREFIX))
            .cloned()
            .collect();
        if remote.len() >= REMOTE_CACHE {
            for key in remote.into_iter().take(REMOTE_CACHE / 2) {
                cache.remove(&key);
            }
        }
        cache.insert(key, decoded);
    }

    pub fn forget_sound(&self, id: &str) {
        self.sound_cache.lock().remove(id);
        self.stop_sound(id);
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
                self.play_sound(&id, None)?;
                Ok(false)
            }
            HotkeyEvent::Pressed(HotkeyAction::StopAllSounds) => {
                self.stop_all_from_hotkey();
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

/// Runs `work` in a fresh dot-folder under `parent` (lists of sounds and models skip
/// dot-folders while they hold a partial download), then removes it whatever `work` returned.
pub fn with_download_dir<T>(
    parent: &Path,
    work: impl FnOnce(&Path) -> AppResult<T>,
) -> AppResult<T> {
    let tmp = parent.join(format!(".download-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)
        .map_err(|e| AppError::Other(format!("dossier temporaire impossible : {e}")))?;
    let result = work(&tmp);
    if let Err(e) = std::fs::remove_dir_all(&tmp) {
        tracing::warn!("dossier temporaire non supprimé ({}) : {e}", tmp.display());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::PlaybackGate;
    use std::sync::{mpsc, Arc, Barrier};

    #[test]
    fn a_stop_all_cancels_the_plays_not_started_yet() {
        let gate = PlaybackGate::default();
        let downloading = gate.admit("downloading", None).unwrap();
        assert_eq!(gate.stop_all(|| {}), ["downloading"]);
        let mut sent = false;
        assert!(!gate.start(&downloading, || sent = true));
        assert!(!sent);
        // A play accepted after the stop starts.
        let later = gate.admit("later", None).unwrap();
        assert!(gate.start(&later, || sent = true));
        assert!(sent);
    }

    #[test]
    fn stopping_one_play_cancels_it_and_leaves_the_others() {
        let gate = PlaybackGate::default();
        let a = gate.admit("a", None).unwrap();
        let b = gate.admit("b", None).unwrap();
        assert!(gate.stop("a", || {}));
        assert!(!gate.start(&a, || {}));
        assert!(gate.start(&b, || {}));
        // Started once: a second start does nothing, and stopping it cancels nothing.
        assert!(!gate.start(&b, || {}));
        assert!(!gate.stop("b", || {}));
    }

    #[test]
    fn only_the_latest_play_of_a_replayed_sound_starts_or_fails() {
        // Pad A is clicked, stopped and clicked again while its first decode runs.
        let gate = PlaybackGate::default();
        let first = gate.admit("A", None).unwrap();
        assert!(gate.stop("A", || {}));
        let second = gate.admit("A", None).unwrap();
        // The first decode ends first: it neither starts nor takes the second's place.
        let mut which = Vec::new();
        assert!(!gate.start(&first, || which.push("first")));
        assert!(!gate.fail(&first));
        assert!(gate.start(&second, || which.push("second")));
        assert_eq!(which, ["second"]);
        // Replayed without a stop: the older admission is replaced the same way.
        let older = gate.admit("A", None).unwrap();
        let newer = gate.admit("A", None).unwrap();
        assert!(!gate.start(&older, || {}));
        assert!(gate.fail(&newer));
    }

    #[test]
    fn a_play_clicked_before_a_shortcut_stop_never_starts_whichever_runs_first() {
        // The play's check and admission happen under the lock the shortcut takes:
        // either the play is refused, or it was admitted and the stop cancels it.
        for _ in 0..200 {
            let gate = Arc::new(PlaybackGate::default());
            let player = {
                let gate = gate.clone();
                std::thread::spawn(move || gate.admit("clicked", Some(0)))
            };
            let (stops, cancelled) = gate.stop_all_from_hotkey(|| {});
            assert_eq!(stops, 1);
            match player.join().unwrap() {
                Some(admission) => {
                    assert_eq!(cancelled, ["clicked"]);
                    assert!(!gate.start(&admission, || {}));
                }
                None => assert!(cancelled.is_empty()),
            }
        }
        // A play clicked knowing the latest count is accepted.
        let gate = PlaybackGate::default();
        gate.stop_all_from_hotkey(|| {});
        assert!(gate.admit("old", Some(0)).is_none());
        let fresh = gate.admit("fresh", Some(1)).unwrap();
        assert!(gate.start(&fresh, || {}));
    }

    #[test]
    fn a_stop_racing_a_start_always_reaches_the_engine_last() {
        // The play has passed its check and is about to send when the stop arrives:
        // the stop must wait, so the engine never ends on a cancelled play.
        let gate = Arc::new(PlaybackGate::default());
        let admission = gate.admit("p", None).unwrap();
        let (tx, rx) = mpsc::channel();
        let in_play = Arc::new(Barrier::new(2));
        let player = {
            let (gate, tx, in_play) = (gate.clone(), tx.clone(), in_play.clone());
            std::thread::spawn(move || {
                gate.start(&admission, || {
                    in_play.wait();
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    tx.send("play").unwrap();
                })
            })
        };
        in_play.wait();
        assert!(gate.stop_all(|| tx.send("stop").unwrap()).is_empty());
        assert!(player.join().unwrap());
        drop(tx);
        assert_eq!(rx.iter().collect::<Vec<_>>(), ["play", "stop"]);
    }
}
