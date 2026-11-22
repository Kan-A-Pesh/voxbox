//! The UI's browser mock uses data generated from the real presets and catalog;
//! this fails when they drift. Regenerate with
//! `cargo run -p voxbox-dsp --example dump_presets -- ui/src/ipc/generated`.

use std::path::Path;

/// Extracts the JSON literal of `export const X: T[] = <json>;`.
fn generated(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../ui/src/ipc/generated")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let start = text.find("[] = ").expect("export const ... = ") + 5;
    let end = text.rfind(';').expect("trailing ;");
    serde_json::from_str(&text[start..end]).unwrap()
}

/// Through a string, so f32 values compare as their shortest decimal form (as in the file).
fn current<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}

#[test]
fn ui_mock_presets_match_builtin_presets() {
    assert_eq!(
        generated("presets.ts"),
        current(&voxbox_dsp::builtin_presets())
    );
}

#[test]
fn ui_mock_catalog_matches_effect_catalog() {
    assert_eq!(
        generated("catalog.ts"),
        current(&voxbox_dsp::effect_catalog())
    );
}
