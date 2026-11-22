//! Notification-area icon: show the window, toggle the voice, quit.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::hotkeys::{HotkeyAction, HotkeyEvent};
use crate::state::AppState;

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Ouvrir VoxBox", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        "Activer / couper la voix",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("VoxBox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "toggle" => {
                let state = app.state::<AppState>();
                match state.handle_hotkey(HotkeyEvent::Pressed(HotkeyAction::ToggleVoice)) {
                    Ok(_) => state.emit_snapshot(app),
                    Err(e) => tracing::warn!("{e}"),
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
