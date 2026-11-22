//! Local AI voice conversion (RVC v2) for VoxBox.
//!
//! CONTRACT (used by `voxbox-engine` and `src-tauri`):
//! - Models live in `<models_dir>/<id>/` as `model.onnx`, optional `index.bin`, and
//!   `meta.json` ([`AiModelMeta`]).
//! - Shared networks (ContentVec, RMVPE) live in `<assets_dir>/` and are loaded once
//!   into [`RvcRuntime`].
//! - [`RvcStream`] runs inference on its own worker thread: the audio thread only
//!   calls [`RvcStream::push`] and [`RvcStream::pop`], which never block or allocate.
//! - Audio in and out is mono `f32` at 48 kHz.

use std::path::{Path, PathBuf};

mod audio;
mod inference;
mod models;
mod queue;
mod stream;
pub use models::{import_model, list_models};
use std::sync::{Arc, Mutex};
pub use stream::{ErrorHandler, RvcStream};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum RvcError {
    #[error("modèle introuvable : {0}")]
    ModelNotFound(PathBuf),
    #[error("échec du chargement ONNX : {0}")]
    Onnx(String),
    #[error("échec de la conversion : {0}")]
    Conversion(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, RvcError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Cuda,
    DirectMl,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub backend: Backend,
    /// GPU name as reported by the driver, e.g. "NVIDIA GeForce RTX 4070".
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelMeta {
    pub id: String,
    pub name: String,
    /// Native output rate of the RVC synthesizer (32000, 40000 or 48000).
    pub model_sample_rate: u32,
    pub has_index: bool,
    /// True for voices shipped with VoxBox.
    pub builtin: bool,
    /// Attribution / licence text shown in the UI for bundled voices.
    #[serde(default)]
    pub license: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RvcParams {
    /// Pitch transposition applied before synthesis.
    pub pitch_semitones: f32,
    /// 0..1, how much retrieved index features replace the input features.
    pub index_rate: f32,
    /// Inference block length; larger = more stable, more latency.
    pub block_ms: u32,
    pub crossfade_ms: u32,
}

impl Default for RvcParams {
    fn default() -> Self {
        Self {
            pitch_semitones: 0.0,
            index_rate: 0.5,
            block_ms: 250,
            crossfade_ms: 50,
        }
    }
}

/// Picks CUDA, DirectML, then CPU, probing an actual session on device zero.
/// `assets_dir` is where the packaged ONNX Runtime / DirectML DLLs live (the
/// "Voix IA" pack's `rvc-assets`); without it only `ORT_DYLIB_PATH` and the
/// executable's folder are searched.
pub fn detect_backend(assets_dir: Option<&Path>) -> BackendInfo {
    inference::detect_backend(assets_dir)
}

/// Shared ContentVec/RMVPE sessions. All ONNX work occurs off the audio thread.
pub struct RvcRuntime {
    networks: Arc<Mutex<inference::Networks>>,
    backend: BackendInfo,
}

impl RvcRuntime {
    pub fn load(assets_dir: &Path, backend: Backend) -> Result<Self> {
        let networks = inference::Networks::load(assets_dir, backend)?;
        Ok(Self {
            networks: Arc::new(Mutex::new(networks)),
            backend: inference::backend_info(backend),
        })
    }

    pub fn backend(&self) -> &BackendInfo {
        &self.backend
    }
}

#[derive(Debug, Clone)]
pub struct ConverterPaths {
    pub python_exe: PathBuf,
    pub script: PathBuf,
}
