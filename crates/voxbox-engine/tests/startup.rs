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
    assert!(message.contains("Réglages"), "{message}");
    // Changing devices afterwards still goes through the same engine.
    let _ = engine.set_devices(DeviceSelection::default());
}
