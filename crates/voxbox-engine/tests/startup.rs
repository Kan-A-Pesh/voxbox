//! A saved device that no longer exists must not prevent the engine (and so the
//! app and its Réglages screen) from starting.

use std::sync::mpsc;
use std::time::Duration;

use voxbox_engine::{DeviceSelection, Engine, EngineEvent};

#[test]
fn missing_saved_device_still_starts_and_reports_it() {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let selection = DeviceSelection {
        input: Some("Casque USB débranché depuis".into()),
        cable: None,
        monitor: Some("Casque USB débranché depuis".into()),
    };
    let engine = Engine::start(
        selection,
        Box::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
    )
    .expect("the engine starts even when a saved device is gone");

    let message = loop {
        match rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a DeviceError is reported")
        {
            EngineEvent::DeviceError { message } => break message,
            _ => continue,
        }
    };
    assert!(message.contains("introuvable"), "{message}");
    let status = engine.status();
    if status.running {
        // The system defaults opened: said so, and nothing is shown as broken.
        assert!(
            message.contains("périphériques par défaut du système"),
            "{message}"
        );
        assert!(status.last_error.is_none());
    } else {
        assert!(
            message.contains("Nouvelle tentative automatique"),
            "{message}"
        );
    }
    // Without any usable device (CI machines) the reason stays visible and the
    // engine keeps restarting on its own (transitions are tested with a fake
    // backend in src/manager.rs).
    if !status.running {
        assert!(status
            .last_error
            .is_some_and(|e| e.contains("Nouvelle tentative")));
        assert!(status.restarting);
        // Past the first automatic attempt (1 s): still retrying, reason kept.
        std::thread::sleep(Duration::from_millis(1_300));
        let later = engine.status();
        assert!(later.restarting && !later.running);
        assert!(later
            .last_error
            .is_some_and(|e| e.contains("Nouvelle tentative")));
        assert!(
            later.revision > status.revision,
            "the retry updated the status"
        );
    }
    // Changing devices afterwards still goes through the same engine.
    let _ = engine.set_devices(DeviceSelection::default());
}
