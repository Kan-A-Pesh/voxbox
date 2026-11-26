//! Tauri commands. Names, arguments and results mirror `ui/src/ipc/contract.ts`.
//! All commands run off the main thread (`async`) because some touch the disk,
//! the network or decode audio.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};
use voxbox_dsp::{EffectSpec, VoicePreset};
use voxbox_engine::Devices;
use voxbox_myinstants::{RemoteSound, SearchPage};
use voxbox_rvc::{AiModelMeta, ConverterPaths};

use crate::hotkeys::{HotkeyAction, HotkeyBinding};
use crate::state::{AppError, AppResult, AppState, Snapshot};
use crate::store::{AppSettings, SettingsPatch, Sound, SoundSource, StoredSound};

const AUDIO_EXTENSIONS: [&str; 4] = ["mp3", "wav", "ogg", "flac"];

#[tauri::command(async)]
pub fn get_snapshot(state: State<'_, AppState>) -> Snapshot {
    state.snapshot()
}

#[tauri::command(async)]
pub fn list_devices() -> Devices {
    voxbox_engine::list_devices()
}

#[tauri::command(async)]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut patch: SettingsPatch,
) -> AppResult<AppSettings> {
    let requested_devices = patch
        .devices
        .take()
        .map(|d| crate::store::sanitize_devices(d, &voxbox_engine::list_devices()));
    let devices_changed = requested_devices.is_some();
    let voice_changed = patch.active_voice_id.is_some() || patch.ai_params.is_some();
    // One persistence boundary for the whole patch; the store lock is held while
    // the engine reopens devices and while the new flags are published, so
    // concurrent changes are serialized end to end.
    let settings = crate::store::commit_and_publish(
        &state.store,
        |next| next.apply(patch),
        requested_devices,
        |d| state.engine.set_devices(d.clone()).map_err(AppError::from),
        |s| {
            state.publish_flags(s);
            if devices_changed {
                // Under the store lock, saved or not: restarts aim at what is
                // saved, in the order changes were saved.
                state.engine.set_target(s.devices.clone());
            }
        },
    )?;
    if voice_changed {
        state.apply_voice()?;
    }
    if devices_changed {
        state.emit_snapshot(&app);
    }
    Ok(settings)
}

/// Adds or removes one favorite voice (in the saved list, whatever else changed it).
#[tauri::command]
pub fn set_voice_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> AppResult<AppSettings> {
    crate::store::commit_and_publish(
        &state.store,
        |next| {
            let mut ids = next.favorite_voice_ids.clone();
            ids.retain(|x| *x != id);
            if favorite {
                ids.push(id);
            }
            next.apply(crate::store::SettingsPatch {
                favorite_voice_ids: Some(ids),
                ..Default::default()
            });
        },
        None,
        |_| Ok::<(), AppError>(()),
        |s| state.publish_flags(s),
    )
}

#[tauri::command(async)]
pub fn set_active_voice(state: State<'_, AppState>, id: String) -> AppResult<AppSettings> {
    let ai_models = state.ai_models();
    let settings = {
        let mut store = state.store.lock();
        if store.find_voice(&id, &ai_models).is_none() {
            return Err(crate::store::StoreError::VoiceNotFound(id).into());
        }
        let mut next = store.settings.clone();
        next.active_voice_id = id;
        store.commit_settings(next, false, |_| Ok::<(), AppError>(()))?;
        store.settings.clone()
    };
    state.apply_voice()?;
    Ok(settings)
}

#[tauri::command(async)]
pub fn save_voice(state: State<'_, AppState>, voice: VoicePreset) -> AppResult<VoicePreset> {
    let saved = state.store.lock().save_voice(voice)?;
    if state.store.lock().settings.active_voice_id == saved.id {
        state.apply_voice()?;
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn delete_voice(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.lock().delete_voice(&id)?;
    state.refresh_hotkeys();
    state.apply_voice()
}

#[tauri::command(async)]
pub fn preview_effects(
    state: State<'_, AppState>,
    effects: Option<Vec<EffectSpec>>,
) -> AppResult<()> {
    state.set_preview(effects)
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

fn display_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Son")
        .replace(['_', '-'], " ")
        .trim()
        .to_string()
}

/// Copies an audio file into the bank after checking it decodes.
fn import_file(
    state: &AppState,
    src: &Path,
    name: String,
    source: SoundSource,
    source_url: Option<String>,
) -> AppResult<Sound> {
    let ext = extension_of(src)
        .filter(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| {
            AppError::Other(format!(
                "format non pris en charge : {} (mp3, wav, ogg ou flac)",
                src.display()
            ))
        })?;
    let decoded = voxbox_engine::decode_file(src)?;
    let id = uuid::Uuid::new_v4().to_string();
    let file = format!("{id}.{ext}");
    let dest = state.store.lock().sounds_dir().join(&file);
    fs::copy(src, &dest)
        .map_err(|e| AppError::Other(format!("copie impossible de {} : {e}", src.display())))?;
    let stored = StoredSound {
        sound: Sound {
            id,
            name: if name.is_empty() {
                String::from("Son")
            } else {
                name
            },
            category: None,
            favorite: false,
            volume: 1.0,
            looped: false,
            hotkey: None,
            duration_ms: decoded.duration_ms,
            source,
            source_url,
            color: None,
        },
        file,
    };
    let added = state.store.lock().add_sound(stored);
    if added.is_err() {
        let _ = fs::remove_file(&dest);
    }
    Ok(added?)
}

/// Imports what it can; fails only if nothing could be imported.
#[tauri::command(async)]
pub fn import_sounds(state: State<'_, AppState>, paths: Vec<PathBuf>) -> AppResult<Vec<Sound>> {
    let mut imported = Vec::new();
    let mut errors = Vec::new();
    for path in &paths {
        match import_file(&state, path, display_name(path), SoundSource::Local, None) {
            Ok(s) => imported.push(s),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if imported.is_empty() && !errors.is_empty() {
        return Err(AppError::Other(errors.join("\n")));
    }
    for e in &errors {
        tracing::warn!("import ignoré : {e}");
    }
    Ok(imported)
}

#[tauri::command(async)]
pub fn update_sound(state: State<'_, AppState>, sound: Sound) -> AppResult<Sound> {
    let out = state.store.lock().update_sound(sound)?;
    state.refresh_hotkeys();
    Ok(out)
}

#[tauri::command(async)]
pub fn delete_sound(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.forget_sound(&id);
    let file = state.store.lock().delete_sound(&id)?;
    state.refresh_hotkeys();
    if let Err(e) = fs::remove_file(&file) {
        tracing::warn!("fichier {} non supprimé : {e}", file.display());
    }
    Ok(())
}

// Sound commands: the UI sends them one at a time, each after the previous one
// answered (ui/src/lib/soundCommands.ts), so they run in click order. They answer at
// once: downloads and decoding run on their own threads afterwards (see
// `PlaybackGate`). Each carries the page that sent it: after a reload, a command of
// the old page arriving late is ignored.

/// What a page needs before its first sound command.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundPage {
    /// The page loaded now (see `AppState::start_page`).
    pub page: u64,
    /// See `AppState::hotkey_stops`.
    pub hotkey_stops: u64,
}

/// A request of a page since replaced only gets an answer nobody reads.
#[tauri::command]
pub fn begin_page(state: State<'_, AppState>) -> SoundPage {
    SoundPage {
        page: state.current_page(),
        hotkey_stops: state.hotkey_stops(),
    }
}

/// Plays a sound of the bank (once decoded; a failure arrives as `sound-failed`).
/// `stops`: the shortcut's stop count the UI knew when the play was clicked.
#[tauri::command]
pub fn play_sound(state: State<'_, AppState>, id: String, page: u64, stops: u64) -> AppResult<()> {
    if !state.is_current_page(page) {
        return Ok(());
    }
    state.play_sound(&id, Some(stops))
}

#[tauri::command]
pub fn stop_sound(state: State<'_, AppState>, id: String, page: u64) {
    if state.is_current_page(page) {
        state.stop_sound(&id);
    }
}

#[tauri::command]
pub fn stop_all_sounds(state: State<'_, AppState>, page: u64) {
    if state.is_current_page(page) {
        state.stop_all_sounds();
    }
}

/// MyInstants uses `reqwest::blocking`, which must not run inside an async task
/// (`#[tauri::command(async)]` only moves work to the async runtime): it panics in
/// debug builds and ties up executor threads. These commands use the blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Other(format!("tâche interrompue : {e}")))?
}

#[tauri::command]
pub async fn myinstants_trending(page: u32) -> AppResult<SearchPage> {
    blocking(move || Ok(voxbox_myinstants::Client::new().trending(page.max(1))?)).await
}

#[tauri::command]
pub async fn myinstants_search(query: String, page: u32) -> AppResult<SearchPage> {
    blocking(move || {
        let client = voxbox_myinstants::Client::new();
        let query = query.trim();
        Ok(if query.is_empty() {
            client.trending(page.max(1))?
        } else {
            client.search(query, page.max(1))?
        })
    })
    .await
}

/// Plays a MyInstants sound without adding it: to everyone, or in the headset
/// only when `preview`. Returns the playback id at once (stop it with
/// `stop_sound`); the sound starts once downloaded, and a failure arrives as
/// `sound-failed`. `replace` (a playback switching mode) is stopped first.
#[tauri::command]
pub fn myinstants_play(
    state: State<'_, AppState>,
    sound: RemoteSound,
    preview: bool,
    replace: Option<String>,
    page: u64,
    stops: u64,
) -> AppResult<String> {
    if !state.is_current_page(page) {
        return Err(AppError::Other(String::from(
            "page rechargée : relance le son",
        )));
    }
    if let Some(id) = replace {
        state.stop_sound(&id);
    }
    Ok(state.play_remote(&sound, preview, stops))
}

#[tauri::command]
pub async fn myinstants_add(
    app: AppHandle,
    sound: RemoteSound,
    category: Option<String>,
) -> AppResult<Sound> {
    blocking(move || {
        let state = app.state::<AppState>();
        let result = state.with_myinstants_file(&sound, |path| {
            import_file(
                &state,
                path,
                sound.title.trim().to_string(),
                SoundSource::Myinstants,
                Some(sound.page_url.clone()),
            )
        });
        let mut added = result?;
        if category.as_deref().is_some_and(|c| !c.trim().is_empty()) {
            added.category = category;
            added = state.store.lock().update_sound(added)?;
        }
        Ok(added)
    })
    .await
}

#[tauri::command(async)]
pub fn set_hotkey(
    state: State<'_, AppState>,
    action: HotkeyAction,
    accelerator: Option<String>,
) -> AppResult<Vec<HotkeyBinding>> {
    let accelerator = accelerator.filter(|a| !a.trim().is_empty());
    let bindings = {
        let mut store = state.store.lock();
        store.set_hotkey(action, accelerator)?;
        store.hotkeys.clone()
    };
    state.refresh_hotkeys();
    Ok(bindings)
}

#[tauri::command(async)]
pub fn import_ai_model(
    app: AppHandle,
    state: State<'_, AppState>,
    pth_path: PathBuf,
    index_path: Option<PathBuf>,
    name: String,
) -> AppResult<AiModelMeta> {
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::store::StoreError::EmptyName.into());
    }
    let converter = ConverterPaths {
        python_exe: state.resources.python_exe.clone(),
        script: state.resources.converter_script.clone(),
    };
    if !converter.python_exe.exists() {
        return Err(AppError::Other(String::from(
            "le convertisseur de voix IA n'est pas installé : installez le pack « VoxBox - Voix IA »",
        )));
    }
    let models_dir = state.store.lock().models_dir();
    let mut progress = |p: f32| {
        let _ = app.emit(
            "ai-import-progress",
            serde_json::json!({ "progress": p.clamp(0.0, 1.0) }),
        );
    };
    let meta = voxbox_rvc::import_model(
        &converter,
        &pth_path,
        index_path.as_deref(),
        name,
        &models_dir,
        &mut progress,
    )?;
    state.emit_snapshot(&app);
    Ok(meta)
}

#[tauri::command(async)]
pub fn delete_ai_model(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let model = state
        .ai_models()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::Other(format!("modèle IA introuvable : {id}")))?;
    if model.builtin {
        return Err(AppError::Other(String::from(
            "les voix IA fournies avec VoxBox ne peuvent pas être supprimées",
        )));
    }
    state.store.lock().forget_ai_model(&id)?;
    state.refresh_hotkeys();
    state.apply_voice()?;
    let dir = state.model_dir(&model);
    fs::remove_dir_all(&dir).map_err(|e| {
        AppError::Other(format!("suppression impossible de {} : {e}", dir.display()))
    })?;
    state.emit_snapshot(&app);
    Ok(())
}

/// Writes an error the UI showed (or an uncaught one) to voxbox.log, where the
/// user can copy it. Bounded: a runaway message cannot flood the log.
#[tauri::command]
pub fn log_client_error(context: String, message: String) {
    const MAX: usize = 4000;
    let clip = |text: &str, max: usize| -> String {
        match text.char_indices().nth(max) {
            Some((at, _)) => format!("{}… (tronqué)", &text[..at]),
            None => text.to_owned(),
        }
    };
    tracing::error!(target: "voxbox_app::ui", "{} : {}", clip(&context, 200), clip(&message, MAX));
}

/// Opens `<app data>/logs` in the file explorer so the user can send `voxbox.log`.
#[tauri::command(async)]
pub fn open_logs_folder(app: AppHandle) -> AppResult<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("dossier des journaux introuvable : {e}")))?
        .join("logs");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Other(format!("dossier des journaux impossible : {e}")))?;
    let explorer = if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(explorer)
        .arg(&dir)
        .spawn()
        .map_err(|e| AppError::Other(format!("impossible d'ouvrir {} : {e}", dir.display())))?;
    Ok(())
}
