//! Global hotkeys.
//!
//! `RegisterHotKey` only reports presses and cannot see a key being held, which
//! push-to-talk needs, so Windows uses low-level keyboard and mouse hooks
//! (`WH_KEYBOARD_LL` / `WH_MOUSE_LL`) on a dedicated thread. They keep working
//! while a game has focus (unless its anti-cheat blocks hooks). Parsing and
//! matching are platform-independent and unit-tested.

// Matching is only driven by the Windows hooks; elsewhere it is exercised by tests.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HotkeyAction {
    Voice { id: String },
    Sound { id: String },
    ToggleVoice,
    ToggleMonitor,
    PushToTalk,
    StopAllSounds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub action: HotkeyAction,
    pub accelerator: String,
}

/// Virtual-key codes (Windows values, used on every platform for matching).
pub mod vk {
    pub const SHIFT: u32 = 0x10;
    pub const CONTROL: u32 = 0x11;
    pub const MENU: u32 = 0x12;
    pub const LSHIFT: u32 = 0xA0;
    pub const RSHIFT: u32 = 0xA1;
    pub const LCONTROL: u32 = 0xA2;
    pub const RCONTROL: u32 = 0xA3;
    pub const LMENU: u32 = 0xA4;
    pub const RMENU: u32 = 0xA5;
    pub const LWIN: u32 = 0x5B;
    pub const RWIN: u32 = 0x5C;
    pub const XBUTTON1: u32 = 0x05;
    pub const XBUTTON2: u32 = 0x06;
    pub const MBUTTON: u32 = 0x04;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Accelerator {
    pub mods: Modifiers,
    pub vk: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AcceleratorError {
    #[error("raccourci vide")]
    Empty,
    #[error("touche inconnue : {0}")]
    UnknownKey(String),
    #[error("un raccourci doit contenir une seule touche principale")]
    MultipleKeys,
    #[error("un raccourci doit contenir une touche principale, pas seulement des modificateurs")]
    OnlyModifiers,
}

fn key_code(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    if bytes.len() == 1 && (bytes[0].is_ascii_uppercase() || bytes[0].is_ascii_digit()) {
        return Some(u32::from(bytes[0]));
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    if let Some(n) = upper
        .strip_prefix("NUMPAD")
        .and_then(|n| n.parse::<u32>().ok())
    {
        if n <= 9 {
            return Some(0x60 + n);
        }
    }
    Some(match upper.as_str() {
        "SPACE" => 0x20,
        "ENTER" | "RETURN" => 0x0D,
        "TAB" => 0x09,
        "ESCAPE" | "ESC" => 0x1B,
        "BACKSPACE" => 0x08,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "CAPSLOCK" => 0x14,
        "PAUSE" => 0x13,
        "NUMPADADD" => 0x6B,
        "NUMPADSUBTRACT" => 0x6D,
        "NUMPADMULTIPLY" => 0x6A,
        "NUMPADDIVIDE" => 0x6F,
        "NUMPADDECIMAL" => 0x6E,
        "NUMPADENTER" => 0x0D, // same virtual key as Enter for low-level hooks
        "SCROLLLOCK" => 0x91,
        "PRINTSCREEN" => 0x2C,
        "MEDIAPLAYPAUSE" => 0xB3,
        "MEDIATRACKNEXT" => 0xB0,
        "MEDIATRACKPREVIOUS" => 0xB1,
        // US-layout OEM keys, named like the UI capture (physical position).
        "-" => 0xBD,
        "=" => 0xBB,
        "[" => 0xDB,
        "]" => 0xDD,
        ";" => 0xBA,
        "'" => 0xDE,
        "`" => 0xC0,
        "\\" => 0xDC,
        "," => 0xBC,
        "." => 0xBE,
        "/" => 0xBF,
        "MOUSEMIDDLE" => vk::MBUTTON,
        "MOUSEX1" => vk::XBUTTON1,
        "MOUSEX2" => vk::XBUTTON2,
        // Bare modifiers are allowed as the main key for push-to-talk
        // (e.g. "LShift" held to talk).
        "LSHIFT" => vk::LSHIFT,
        "RSHIFT" => vk::RSHIFT,
        "LCTRL" => vk::LCONTROL,
        "RCTRL" => vk::RCONTROL,
        "LALT" => vk::LMENU,
        "RALT" => vk::RMENU,
        _ => return None,
    })
}

/// Parses "Ctrl+Alt+1", "F13", "Shift+F2", "Numpad5", "MouseX1", "LShift".
pub fn parse_accelerator(text: &str) -> Result<Accelerator, AcceleratorError> {
    let mut mods = Modifiers::default();
    let mut key = None;
    let mut any = false;
    for part in text.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        any = true;
        match part.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => mods.ctrl = true,
            "ALT" => mods.alt = true,
            "SHIFT" => mods.shift = true,
            "WIN" | "SUPER" | "META" => mods.win = true,
            _ => {
                let code =
                    key_code(part).ok_or_else(|| AcceleratorError::UnknownKey(part.to_string()))?;
                if key.replace(code).is_some() {
                    return Err(AcceleratorError::MultipleKeys);
                }
            }
        }
    }
    if !any {
        return Err(AcceleratorError::Empty);
    }
    let vk = key.ok_or(AcceleratorError::OnlyModifiers)?;
    Ok(Accelerator { mods, vk })
}

fn is_side_modifier(code: u32) -> bool {
    matches!(
        code,
        vk::LSHIFT
            | vk::RSHIFT
            | vk::LCONTROL
            | vk::RCONTROL
            | vk::LMENU
            | vk::RMENU
            | vk::LWIN
            | vk::RWIN
    )
}

/// What the hook thread reports to the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyEvent {
    Pressed(HotkeyAction),
    Released(HotkeyAction),
}

impl HotkeyEvent {
    pub fn is_push_to_talk(&self) -> bool {
        matches!(
            self,
            Self::Pressed(HotkeyAction::PushToTalk) | Self::Released(HotkeyAction::PushToTalk)
        )
    }
}

/// Tracks held keys and turns raw key transitions into binding events.
/// A binding fires once on press (auto-repeat is ignored) and its release is
/// reported when its main key goes up, even if modifiers were released first.
#[derive(Debug, Default)]
pub struct Matcher {
    bindings: Vec<(Accelerator, HotkeyAction)>,
    held: std::collections::HashSet<u32>,
    active: Vec<(u32, HotkeyAction)>,
}

impl Matcher {
    pub fn new(bindings: &[HotkeyBinding]) -> Self {
        let mut m = Self::default();
        m.set_bindings(bindings);
        m
    }

    /// Invalid accelerators are skipped (they are validated when saved).
    /// Keys currently held keep their pending release: rebinding while
    /// push-to-talk is held must not leave the microphone open.
    pub fn set_bindings(&mut self, bindings: &[HotkeyBinding]) {
        self.bindings = bindings
            .iter()
            .filter_map(|b| {
                parse_accelerator(&b.accelerator)
                    .ok()
                    .map(|a| (a, b.action.clone()))
            })
            .collect();
    }

    fn mods(&self) -> Modifiers {
        let h = |a: u32, b: u32| self.held.contains(&a) || self.held.contains(&b);
        Modifiers {
            ctrl: h(vk::LCONTROL, vk::RCONTROL) || self.held.contains(&vk::CONTROL),
            alt: h(vk::LMENU, vk::RMENU) || self.held.contains(&vk::MENU),
            shift: h(vk::LSHIFT, vk::RSHIFT) || self.held.contains(&vk::SHIFT),
            win: h(vk::LWIN, vk::RWIN),
        }
    }

    pub fn key_down(&mut self, code: u32) -> Vec<HotkeyEvent> {
        if !self.held.insert(code) {
            return Vec::new();
        }
        let mut mods = self.mods();
        // A bare side modifier used as main key must not count as its own modifier.
        if is_side_modifier(code) {
            match code {
                vk::LSHIFT | vk::RSHIFT => mods.shift = false,
                vk::LCONTROL | vk::RCONTROL => mods.ctrl = false,
                vk::LMENU | vk::RMENU => mods.alt = false,
                _ => mods.win = false,
            }
        }
        let mut out = Vec::new();
        for (acc, action) in &self.bindings {
            if acc.vk == code && acc.mods == mods {
                self.active.push((code, action.clone()));
                out.push(HotkeyEvent::Pressed(action.clone()));
            }
        }
        out
    }

    pub fn key_up(&mut self, code: u32) -> Vec<HotkeyEvent> {
        self.held.remove(&code);
        let mut out = Vec::new();
        self.active.retain(|(c, action)| {
            if *c == code {
                out.push(HotkeyEvent::Released(action.clone()));
                false
            } else {
                true
            }
        });
        out
    }
}

#[cfg(windows)]
pub use win::spawn_hook_thread;

#[cfg(windows)]
mod win {
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, OnceLock};

    use parking_lot::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, MSG,
        MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    use super::{vk, HotkeyEvent, Matcher};

    struct HookState {
        matcher: Arc<Mutex<Matcher>>,
        tx: Sender<HotkeyEvent>,
    }

    static STATE: OnceLock<HookState> = OnceLock::new();

    fn dispatch(code: u32, down: bool) {
        if let Some(state) = STATE.get() {
            let events = {
                let mut m = state.matcher.lock();
                if down {
                    m.key_down(code)
                } else {
                    m.key_up(code)
                }
            };
            for e in events {
                let _ = state.tx.send(e);
            }
        }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for WH_KEYBOARD_LL with HC_ACTION, lparam points to a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => dispatch(info.vkCode, true),
                WM_KEYUP | WM_SYSKEYUP => dispatch(info.vkCode, false),
                _ => {}
            }
        }
        // Never swallow keys: the game or chat app still receives them.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for WH_MOUSE_LL with HC_ACTION, lparam points to a MSLLHOOKSTRUCT.
            let info = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
            let xbutton = || {
                if (info.mouseData >> 16) & 0xFFFF == 1 {
                    vk::XBUTTON1
                } else {
                    vk::XBUTTON2
                }
            };
            match wparam as u32 {
                WM_XBUTTONDOWN => dispatch(xbutton(), true),
                WM_XBUTTONUP => dispatch(xbutton(), false),
                WM_MBUTTONDOWN => dispatch(vk::MBUTTON, true),
                WM_MBUTTONUP => dispatch(vk::MBUTTON, false),
                _ => {}
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    /// Installs the hooks on a thread running a message loop (required by
    /// low-level hooks). Only one hook thread per process.
    pub fn spawn_hook_thread(
        matcher: Arc<Mutex<Matcher>>,
        tx: Sender<HotkeyEvent>,
    ) -> Result<(), String> {
        STATE
            .set(HookState { matcher, tx })
            .map_err(|_| String::from("les raccourcis globaux sont déjà actifs"))?;
        std::thread::Builder::new()
            .name("voxbox-hotkeys".into())
            .spawn(|| unsafe {
                let kb =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), std::ptr::null_mut(), 0);
                let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), std::ptr::null_mut(), 0);
                if kb.is_null() || ms.is_null() {
                    tracing::error!("impossible d'installer les hooks clavier/souris");
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind(acc: &str, action: HotkeyAction) -> HotkeyBinding {
        HotkeyBinding {
            action,
            accelerator: acc.into(),
        }
    }

    #[test]
    fn parses_common_accelerators() {
        let a = parse_accelerator("Ctrl+Alt+1").unwrap();
        assert_eq!(a.vk, u32::from(b'1'));
        assert!(a.mods.ctrl && a.mods.alt && !a.mods.shift && !a.mods.win);
        assert_eq!(parse_accelerator("F13").unwrap().vk, 0x7C);
        assert_eq!(
            parse_accelerator("shift+f2").unwrap(),
            Accelerator {
                mods: Modifiers {
                    shift: true,
                    ..Default::default()
                },
                vk: 0x71
            }
        );
        assert_eq!(parse_accelerator("Numpad5").unwrap().vk, 0x65);
        assert_eq!(parse_accelerator("MouseX1").unwrap().vk, vk::XBUTTON1);
        assert_eq!(parse_accelerator("LShift").unwrap().vk, vk::LSHIFT);
    }

    /// Every key name the UI capture can produce (ui/src/lib/accelerator.ts) must
    /// be accepted here, or set_hotkey would refuse a shortcut the UI offered.
    #[test]
    fn accepts_every_key_the_ui_can_capture() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/src/lib/accelerator.ts");
        let source = std::fs::read_to_string(&path).unwrap();
        let start = source.find("const NAMED").expect("NAMED map");
        let block = &source[start..start + source[start..].find("};").unwrap()];
        let mut names: Vec<String> = block
            .split(',')
            .filter_map(|entry| entry.split_once(':').map(|(_, v)| v.trim()))
            .filter_map(|v| v.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
            .map(|v| v.replace("\\\\", "\\"))
            .collect();
        assert!(names.len() > 30, "parsed {names:?}");
        names.extend(('A'..='Z').map(String::from));
        names.extend(('0'..='9').map(String::from));
        names.extend((1..=24).map(|n| format!("F{n}")));
        names.extend((0..=9).map(|n| format!("Numpad{n}")));
        names.extend(["MouseX1".into(), "MouseX2".into()]);
        for name in names {
            assert!(
                parse_accelerator(&format!("Ctrl+Alt+{name}")).is_ok(),
                "UI key « {name} » refused"
            );
        }
    }

    #[test]
    fn rejects_invalid_accelerators() {
        assert_eq!(parse_accelerator(""), Err(AcceleratorError::Empty));
        assert_eq!(
            parse_accelerator("Ctrl+Alt"),
            Err(AcceleratorError::OnlyModifiers)
        );
        assert_eq!(
            parse_accelerator("Ctrl+A+B"),
            Err(AcceleratorError::MultipleKeys)
        );
        assert_eq!(
            parse_accelerator("Ctrl+Banana"),
            Err(AcceleratorError::UnknownKey("Banana".into()))
        );
        assert_eq!(
            parse_accelerator("F25"),
            Err(AcceleratorError::UnknownKey("F25".into()))
        );
    }

    #[test]
    fn fires_once_with_exact_modifiers_and_ignores_repeat() {
        let mut m = Matcher::new(&[bind(
            "Ctrl+Alt+1",
            HotkeyAction::Voice { id: "robot".into() },
        )]);
        assert!(m.key_down(u32::from(b'1')).is_empty(), "no modifiers held");
        m.key_up(u32::from(b'1'));
        m.key_down(vk::LCONTROL);
        m.key_down(vk::LMENU);
        let ev = m.key_down(u32::from(b'1'));
        assert_eq!(
            ev,
            vec![HotkeyEvent::Pressed(HotkeyAction::Voice {
                id: "robot".into()
            })]
        );
        assert!(
            m.key_down(u32::from(b'1')).is_empty(),
            "auto-repeat ignored"
        );
        m.key_down(vk::LSHIFT);
        m.key_up(u32::from(b'1'));
        assert!(
            m.key_down(u32::from(b'1')).is_empty(),
            "extra Shift held: no match"
        );
    }

    #[test]
    fn push_to_talk_reports_release_even_after_modifier_release() {
        let mut m = Matcher::new(&[bind("Ctrl+V", HotkeyAction::PushToTalk)]);
        m.key_down(vk::RCONTROL);
        assert_eq!(
            m.key_down(u32::from(b'V')),
            vec![HotkeyEvent::Pressed(HotkeyAction::PushToTalk)]
        );
        assert!(m.key_up(vk::RCONTROL).is_empty());
        assert_eq!(
            m.key_up(u32::from(b'V')),
            vec![HotkeyEvent::Released(HotkeyAction::PushToTalk)]
        );
    }

    #[test]
    fn refreshing_bindings_while_ptt_is_held_still_releases_it() {
        let bindings = [bind("Ctrl+V", HotkeyAction::PushToTalk)];
        let mut m = Matcher::new(&bindings);
        m.key_down(vk::LCONTROL);
        assert_eq!(
            m.key_down(u32::from(b'V')),
            vec![HotkeyEvent::Pressed(HotkeyAction::PushToTalk)]
        );
        // e.g. a sound was favourited while talking
        m.set_bindings(&bindings);
        assert_eq!(
            m.key_up(u32::from(b'V')),
            vec![HotkeyEvent::Released(HotkeyAction::PushToTalk)]
        );
    }

    #[test]
    fn bare_side_modifier_works_as_push_to_talk() {
        let mut m = Matcher::new(&[bind("LShift", HotkeyAction::PushToTalk)]);
        assert_eq!(
            m.key_down(vk::LSHIFT),
            vec![HotkeyEvent::Pressed(HotkeyAction::PushToTalk)]
        );
        assert_eq!(
            m.key_up(vk::LSHIFT),
            vec![HotkeyEvent::Released(HotkeyAction::PushToTalk)]
        );
        assert!(m.key_down(vk::RSHIFT).is_empty());
    }

    #[test]
    fn action_json_shape_matches_ui_contract() {
        let json = serde_json::to_string(&HotkeyAction::Sound { id: "x".into() }).unwrap();
        assert_eq!(json, r#"{"type":"sound","id":"x"}"#);
        let json = serde_json::to_string(&HotkeyAction::StopAllSounds).unwrap();
        assert_eq!(json, r#"{"type":"stopAllSounds"}"#);
    }
}
