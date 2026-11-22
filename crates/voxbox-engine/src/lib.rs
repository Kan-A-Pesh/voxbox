//! Real-time audio engine.
//!
//! ```text
//! mic ─► noise suppression ─► PTT / voice on-off gate ─► [RVC] ─► VoiceChain ─┐
//!                                                                              ├─► mic bus ─► CABLE Input (VB-Cable)
//! soundboard voices (decoded, 48 kHz mono) ──► × mic volume ───────────────────┘
//!                                         └──► × monitor volume ─┐
//! processed voice (if "M'entendre") ─────────────────────────────┴─► monitor bus ─► headset
//! ```
//!
//! CONTRACT (used by `src-tauri`): every `Engine` method is called from control
//! threads and never blocks the audio thread (changes travel through lock-free
//! queues or atomics). Events are delivered on a non-audio thread.

use std::path::Path;

use serde::{Deserialize, Serialize};
use voxbox_dsp::EffectSpec;

mod decode;
mod device;
pub mod graph;
mod runtime;
mod scheduling;
use voxbox_rvc::RvcStream;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("périphérique audio introuvable : {0}")]
    DeviceNotFound(String),
    #[error("erreur audio : {0}")]
    Stream(String),
    #[error("fichier audio illisible : {0}")]
    Decode(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Stable identifier (device name on WASAPI).
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// True for VB-Cable's "CABLE Input" render endpoint.
    pub is_cable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

/// `None` means "system default" for input/monitor and "auto-detect CABLE Input"
/// for the cable output.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSelection {
    pub input: Option<String>,
    pub cable: Option<String>,
    pub monitor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub input_name: Option<String>,
    pub cable_name: Option<String>,
    pub monitor_name: Option<String>,
    /// False when no VB-Cable endpoint exists: the UI then explains how to install it.
    pub cable_found: bool,
    /// Mic-to-cable latency estimate (buffers + effect latency + RVC).
    pub latency_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    /// ~30 Hz. dBFS, -60 floor.
    #[serde(rename_all = "camelCase")]
    Meter { input_db: f32, output_db: f32 },
    #[serde(rename_all = "camelCase")]
    SoundProgress {
        id: String,
        position_ms: u32,
        duration_ms: u32,
    },
    #[serde(rename_all = "camelCase")]
    SoundEnded { id: String },
    #[serde(rename_all = "camelCase")]
    DeviceError { message: String },
}

#[derive(Debug, Clone)]
pub struct DecodedSound {
    /// Mono, 48 kHz.
    pub samples: std::sync::Arc<[f32]>,
    pub duration_ms: u32,
}

/// Decodes mp3 / wav / ogg / flac to 48 kHz mono.
pub fn decode_file(path: &Path) -> Result<DecodedSound> {
    decode::decode(path)
}

pub fn list_devices() -> Devices {
    device::enumerate()
}

pub type EventSink = Box<dyn Fn(EngineEvent) + Send + Sync + 'static>;

pub struct Engine {
    runtime: runtime::Runtime,
}

impl Engine {
    pub fn start(devices: DeviceSelection, events: EventSink) -> Result<Self> {
        Ok(Self {
            runtime: runtime::Runtime::start(devices, events)?,
        })
    }
    pub fn set_devices(&self, devices: DeviceSelection) -> Result<()> {
        self.runtime.set_devices(devices)
    }
    pub fn status(&self) -> EngineStatus {
        self.runtime.status()
    }
    pub fn set_voice(&self, effects: &[EffectSpec], ai: Option<RvcStream>) {
        self.runtime.voice(effects, ai);
    }
    pub fn set_voice_enabled(&self, enabled: bool) {
        self.runtime
            .settings
            .voice
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn set_monitor(&self, enabled: bool) {
        self.runtime
            .settings
            .monitor
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn set_noise_suppression(&self, enabled: bool) {
        self.runtime
            .settings
            .noise
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn set_ptt_mode(&self, enabled: bool) {
        self.runtime
            .settings
            .ptt
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn set_ptt_pressed(&self, pressed: bool) {
        self.runtime
            .settings
            .pressed
            .store(pressed, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn play_sound(&self, id: &str, sound: DecodedSound, volume: f32, looped: bool) {
        self.runtime
            .command(graph::Command::play(id, sound, volume, looped));
    }
    pub fn stop_sound(&self, id: &str) {
        self.runtime.command(graph::Command::Stop(id.into()));
    }
    pub fn stop_all_sounds(&self) {
        self.runtime.command(graph::Command::StopAll);
    }
    pub fn set_sound_bus(&self, mic_volume: f32, monitor_volume: f32) {
        self.runtime.settings.cable_volume.store(
            graph::level(mic_volume).to_bits(),
            std::sync::atomic::Ordering::Relaxed,
        );
        self.runtime.settings.monitor_volume.store(
            graph::level(monitor_volume).to_bits(),
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}
