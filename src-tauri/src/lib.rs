mod commands;
mod hotkeys;
mod state;
mod store;
mod tray;

use tauri::{Emitter, Manager, WindowEvent};

use crate::state::{AppState, Resources};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let resources = Resources::from_dir(&app.path().resource_dir()?.join("resources"));
            let mut store = store::Store::open(&data_dir)?;
            let devices = store::sanitize_devices(
                store.settings.devices.clone(),
                &voxbox_engine::list_devices(),
            );
            if devices != store.settings.devices {
                tracing::warn!(
                    "périphériques enregistrés absents : retour aux périphériques par défaut"
                );
                store.settings.devices = devices.clone();
                store.save_settings()?;
            }
            let start_minimized = store.settings.start_minimized;

            let handle = app.handle().clone();
            let engine = voxbox_engine::Engine::start(
                devices,
                Box::new(move |event| {
                    let _ = handle.emit("engine", event);
                }),
            )?;

            let ai_installed = resources.ai_assets.exists();
            let backend =
                voxbox_rvc::detect_backend(ai_installed.then_some(resources.ai_assets.as_path()));
            let rvc = if ai_installed {
                match voxbox_rvc::RvcRuntime::load(&resources.ai_assets, backend.backend) {
                    Ok(rt) => Some(rt),
                    Err(e) => {
                        tracing::error!("voix IA indisponibles : {e}");
                        None
                    }
                }
            } else {
                None
            };

            let state = AppState::new(app.handle().clone(), store, engine, rvc, backend, resources);
            if let Err(e) = state.apply_all() {
                tracing::error!("voix active non chargée : {e}");
            }
            app.manage(state);

            spawn_hotkeys(app.handle().clone());
            tray::create(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                if start_minimized {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the voice changer running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::list_devices,
            commands::update_settings,
            commands::set_active_voice,
            commands::save_voice,
            commands::delete_voice,
            commands::preview_effects,
            commands::import_sounds,
            commands::update_sound,
            commands::delete_sound,
            commands::play_sound,
            commands::stop_sound,
            commands::stop_all_sounds,
            commands::myinstants_trending,
            commands::myinstants_search,
            commands::myinstants_add,
            commands::set_hotkey,
            commands::import_ai_model,
            commands::delete_ai_model,
        ])
        .run(tauri::generate_context!())
        .expect("VoxBox n'a pas pu démarrer");
}

/// Push-to-talk transitions are applied by a router thread as soon as they
/// arrive; every other action (decoding a sound, loading an AI model) runs on a
/// separate worker, so a slow action can never delay releasing the microphone.
fn spawn_hotkeys(app: tauri::AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<hotkeys::HotkeyEvent>();
    #[cfg(windows)]
    {
        let matcher = app.state::<AppState>().matcher.clone();
        if let Err(e) = hotkeys::spawn_hook_thread(matcher, tx) {
            tracing::error!("raccourcis globaux indisponibles : {e}");
        }
    }
    #[cfg(not(windows))]
    {
        tracing::warn!("raccourcis globaux disponibles uniquement sous Windows");
        drop(tx);
    }
    let (action_tx, action_rx) = std::sync::mpsc::channel::<hotkeys::HotkeyEvent>();
    let router_app = app.clone();
    std::thread::Builder::new()
        .name("voxbox-hotkey-router".into())
        .spawn(move || {
            for event in rx {
                if event.is_push_to_talk() {
                    run_hotkey(&router_app, event);
                } else if action_tx.send(event).is_err() {
                    break;
                }
            }
        })
        .expect("thread des raccourcis");
    std::thread::Builder::new()
        .name("voxbox-hotkey-actions".into())
        .spawn(move || {
            for event in action_rx {
                run_hotkey(&app, event);
            }
        })
        .expect("thread des actions de raccourcis");
}

fn run_hotkey(app: &tauri::AppHandle, event: hotkeys::HotkeyEvent) {
    let state = app.state::<AppState>();
    match state.handle_hotkey(event) {
        Ok(true) => state.emit_snapshot(app),
        Ok(false) => {}
        Err(e) => tracing::warn!("raccourci : {e}"),
    }
}
