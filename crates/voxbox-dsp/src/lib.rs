//! Real-time voice effects for VoxBox.
//!
//! CONTRACT (shared with `voxbox-engine` and the UI, do not change shapes without
//! updating both):
//! - Audio is mono `f32` in `[-1, 1]` at [`SAMPLE_RATE`], processed in place in
//!   blocks of any length (the engine uses [`BLOCK_SIZE`]).
//! - A voice is a [`VoicePreset`]: an ordered list of [`EffectSpec`]s. Each spec is
//!   `{ kind, params, enabled }` so the UI can render any effect generically from
//!   [`effect_catalog`].
//! - [`VoiceChain`] is built from specs, never allocates in [`VoiceChain::process`],
//!   and is `Send` so it can live on the audio thread.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SAMPLE_RATE: u32 = 48_000;
/// 10 ms at 48 kHz.
pub const BLOCK_SIZE: usize = 480;

/// Identifier of an effect type. Serialized as camelCase strings (`"pitchShift"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectKind {
    PitchShift,
    FormantShift,
    Gain,
    LowPass,
    HighPass,
    BandPass,
    Distortion,
    Bitcrush,
    RingMod,
    Tremolo,
    Vibrato,
    Echo,
    Reverb,
    Chorus,
    Robotize,
    Whisper,
    NoiseGate,
    Compressor,
}

/// One effect in a chain. Missing params fall back to the catalog defaults;
/// out-of-range params are clamped to the catalog range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectSpec {
    pub kind: EffectKind,
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceCategory {
    Fun,
    Effects,
    Custom,
    Ai,
}

/// A voice shown as a card in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePreset {
    /// Stable id. Built-ins use a slug (`"villager"`), custom voices a uuid.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Pixel icon name understood by the UI (`"home"`, `"bot"`, ...).
    pub icon: String,
    /// `#rrggbb` accent colour of the card.
    pub color: String,
    pub category: VoiceCategory,
    pub effects: Vec<EffectSpec>,
    /// For `VoiceCategory::Ai`: id of the RVC model to run before `effects`.
    #[serde(default)]
    pub ai_model_id: Option<String>,
    #[serde(default)]
    pub builtin: bool,
}

/// UI description of one tunable parameter.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDescriptor {
    pub key: &'static str,
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    pub step: f32,
    pub default: f32,
    pub unit: &'static str,
}

/// UI description of one effect type (labels in French).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectDescriptor {
    pub kind: EffectKind,
    pub label: &'static str,
    pub description: &'static str,
    pub params: Vec<ParamDescriptor>,
}

mod catalog;
mod effects;
mod presets;
mod spectral;

pub use catalog::effect_catalog;
pub use presets::builtin_presets;

/// A built, ready-to-run chain. Construction allocates; processing and reset do not.
/// Rebuild it away from the audio callback when parameters change.
pub struct VoiceChain {
    effects: Vec<effects::Effect>,
    latency: usize,
}

impl VoiceChain {
    pub fn new(effects: &[EffectSpec]) -> Self {
        let catalog = effect_catalog();
        let effects: Vec<_> = effects
            .iter()
            .filter(|spec| spec.enabled)
            .filter_map(|spec| {
                catalog
                    .iter()
                    .find(|d| d.kind == spec.kind)
                    .map(|descriptor| effects::Effect::new(spec, descriptor))
            })
            .collect();
        let latency = effects.iter().map(effects::Effect::latency_samples).sum();
        Self { effects, latency }
    }

    /// Processes any block length in place, including an empty slice. No allocation
    /// or locking. Non-finite input is treated as silence, and a unity-gain soft
    /// knee above 0.8 prevents overload without colouring quiet speech.
    pub fn process(&mut self, buf: &mut [f32]) {
        for sample in buf.iter_mut() {
            *sample = if sample.is_finite() {
                sample.clamp(-8.0, 8.0)
            } else {
                0.0
            };
        }
        for effect in &mut self.effects {
            effect.process(buf);
        }
        for sample in buf {
            let x = *sample;
            *sample = if !x.is_finite() {
                0.0
            } else if x.abs() > 0.8 {
                x.signum() * (0.8 + 0.2 * ((x.abs() - 0.8) * 5.0).tanh())
            } else {
                x
            };
        }
    }

    /// Clears delay lines, analysis history, oscillators and envelopes.
    pub fn reset(&mut self) {
        for effect in &mut self.effects {
            effect.reset();
        }
    }

    /// Sum of inserted processing delays. For the variable-delay pitch shifter,
    /// reports the conservative maximum look-back (28.7 ms); dry/wet effects add
    /// no alignment latency even though their wet signal has an audible tail.
    pub fn latency_samples(&self) -> usize {
        self.latency
    }
}
