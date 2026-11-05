use crate::{audio, models::FeatureIndex, Backend, BackendInfo, Result, RvcError, RvcParams};
use ort::{
    session::{builder::SessionBuilder, Session},
    value::Tensor,
};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

fn onnx(e: impl std::fmt::Display) -> RvcError {
    RvcError::Onnx(e.to_string())
}

fn library_path(assets: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH") {
        return Ok(path.into());
    }
    let filename = if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    };
    let mut candidates = Vec::new();
    if let Some(dir) = assets {
        candidates.push(dir.join(filename));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(filename));
        }
    }
    candidates.into_iter().find(|p|p.is_file()).ok_or_else(|| onnx("bibliothèque ONNX Runtime absente : fournir ORT_DYLIB_PATH ou la DLL à côté des assets/de l’exécutable"))
}

/// Loading `onnxruntime.dll` by absolute path does not make its folder a
/// dependency search directory on Windows, so `DirectML.dll` and
/// `onnxruntime_providers_shared.dll` next to it would be missed (or the older
/// System32 DirectML picked). Registering the folder covers the preflight, the
/// real ORT load and later provider loads.
#[cfg(windows)]
fn add_dll_search_dir(dir: &Path) -> std::result::Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call.
    unsafe {
        windows::Win32::System::LibraryLoader::SetDllDirectoryW(windows::core::PCWSTR(
            wide.as_ptr(),
        ))
    }
    .map_err(|e| {
        format!(
            "dossier des DLL ONNX Runtime inaccessible ({}) : {e}",
            dir.display()
        )
    })
}

#[cfg(not(windows))]
fn add_dll_search_dir(_dir: &Path) -> std::result::Result<(), String> {
    Ok(())
}

fn initialize(assets: Option<&Path>) -> Result<()> {
    static INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    if let Some(result) = INIT.get() {
        return result.clone().map_err(onnx);
    }
    let path = library_path(assets)?;
    INIT.get_or_init(|| {
        if let Some(dir) = path.parent() {
            add_dll_search_dir(dir)?;
        }
        // Preflight the native loader: ort rc.10 panics when dlopen fails.
        // SAFETY: loading the packaged ONNX Runtime is necessary for its C API;
        // no symbol or pointer outlives the library here.
        let library = unsafe { libloading::Library::new(&path) }.map_err(|e| e.to_string())?;
        drop(library);
        std::panic::catch_unwind(|| {
            ort::init_from(path.to_string_lossy())
                .with_telemetry(false)
                .commit()
        })
        .map_err(|_| "ONNX Runtime incompatible (API 1.22 requise)".to_owned())?
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .clone()
    .map_err(onnx)
}

fn builder(backend: Backend) -> Result<SessionBuilder> {
    let builder = Session::builder()
        .map_err(onnx)?
        .with_intra_threads(2)
        .map_err(onnx)?;
    match backend {
        Backend::Cpu => Ok(builder),
        #[cfg(all(windows, feature = "cuda"))]
        Backend::Cuda => builder
            .with_execution_providers([ort::execution_providers::CUDAExecutionProvider::default()
                .with_device_id(0)
                .build()
                .error_on_failure()])
            .map_err(onnx),
        #[cfg(all(windows, feature = "directml"))]
        Backend::DirectMl => builder
            .with_parallel_execution(false)
            .map_err(onnx)?
            .with_memory_pattern(false)
            .map_err(onnx)?
            .with_execution_providers([
                ort::execution_providers::DirectMLExecutionProvider::default()
                    .with_device_id(0)
                    .build()
                    .error_on_failure(),
            ])
            .map_err(onnx),
        #[allow(unreachable_patterns)]
        _ => Err(onnx("backend non disponible dans cette compilation")),
    }
}

pub(crate) fn backend_info(backend: Backend) -> BackendInfo {
    let device_name = match backend {
        Backend::Cpu => "CPU (ONNX Runtime)".to_owned(),
        Backend::Cuda => std::process::Command::new("nvidia-smi")
            .args(["--id=0", "--query-gpu=name", "--format=csv,noheader"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "CUDA device 0 (nom indisponible)".into()),
        Backend::DirectMl => {
            adapter_name().unwrap_or_else(|| "DirectML adapter 0 (nom indisponible)".into())
        }
    };
    BackendInfo {
        backend,
        device_name,
    }
}
#[cfg(windows)]
fn adapter_name() -> Option<String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    // SAFETY: COM-owned DXGI handles; enumeration index matches DirectML device 0.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let desc = factory.EnumAdapters1(0).ok()?.GetDesc1().ok()?;
        let len = desc
            .Description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(desc.Description.len());
        Some(String::from_utf16_lossy(&desc.Description[..len]))
    }
}
#[cfg(not(windows))]
fn adapter_name() -> Option<String> {
    None
}

pub(crate) fn detect_backend(assets: Option<&Path>) -> BackendInfo {
    if initialize(assets).is_ok() {
        for backend in [Backend::Cuda, Backend::DirectMl, Backend::Cpu] {
            let probe = || -> Result<()> {
                let mut session = builder(backend)?
                    .commit_from_memory(include_bytes!("probe.onnx"))
                    .map_err(onnx)?;
                session
                    .run(ort::inputs![
                        Tensor::from_array(([1], vec![0.0_f32])).map_err(onnx)?
                    ])
                    .map_err(onnx)?;
                Ok(())
            };
            if probe().is_ok() {
                return backend_info(backend);
            }
        }
    }
    backend_info(Backend::Cpu)
}

pub(crate) struct Networks {
    content: Session,
    pitch: Session,
}
impl Networks {
    pub(crate) fn load(assets: &Path, backend: Backend) -> Result<Self> {
        initialize(Some(assets))?;
        let content = builder(backend)?
            .commit_from_file(assets.join("contentvec.onnx"))
            .map_err(onnx)?;
        let pitch = builder(backend)?
            .commit_from_file(assets.join("rmvpe.onnx"))
            .map_err(onnx)?;
        if content.inputs.len() != 2
            || pitch.inputs.len() != 1
            || content.outputs.is_empty()
            || pitch.outputs.is_empty()
        {
            return Err(onnx("interface ContentVec/RMVPE non prise en charge"));
        }
        Ok(Self { content, pitch })
    }
    pub(crate) fn convert(
        &mut self,
        synth: &mut Synthesizer,
        input: &[f32],
        params: RvcParams,
    ) -> Result<Vec<f32>> {
        let samples = audio::resample(input, 48000, 16000);
        let frames = samples.len() / 160;
        let output=self.content.run(ort::inputs![
            "input_values"=>Tensor::from_array(([1,samples.len()],samples.clone())).map_err(onnx)?,
            "attention_mask"=>Tensor::from_array(([1,samples.len()],vec![1_i64;samples.len()])).map_err(onnx)?
        ]).map_err(onnx)?;
        let (shape, features) = output[0].try_extract_tensor::<f32>().map_err(onnx)?;
        if shape.len() != 3 || shape[0] != 1 || shape[2] != 768 || shape[1] < 1 {
            return Err(onnx("ContentVec attendu [1,T,768]"));
        }
        let source_frames = features.len() / 768;
        let mut phone = Vec::with_capacity(frames * 768);
        for i in 0..frames {
            let source = (i / 2).min(source_frames - 1);
            phone.extend_from_slice(&features[source * 768..(source + 1) * 768]);
        }
        drop(output);
        if let Some(index) = &synth.index {
            index.blend(&mut phone, params.index_rate);
        }
        let (padded, mel) = audio::log_mel(&samples);
        let name = self.pitch.inputs[0].name.clone();
        let output = self
            .pitch
            .run(ort::inputs![name=>Tensor::from_array(([1,128,padded],mel)).map_err(onnx)?])
            .map_err(onnx)?;
        let (shape, salience) = output[0].try_extract_tensor::<f32>().map_err(onnx)?;
        if shape.len() != 3 || shape[0] != 1 || shape[2] != 360 || shape[1] < frames as i64 {
            return Err(onnx("RMVPE attendu [1,T,360]"));
        }
        let pitchf = audio::decode_f0(&salience[..frames * 360], params.pitch_semitones);
        let pitch: Vec<i64> = pitchf.iter().map(|&hz| audio::coarse_f0(hz)).collect();
        drop(output);
        let noise = synth.noise(frames * 192);
        let output = synth
            .session
            .run(ort::inputs![
                "phone"=>Tensor::from_array(([1,frames,768],phone)).map_err(onnx)?,
                "phone_lengths"=>Tensor::from_array(([1],vec![frames as i64])).map_err(onnx)?,
                "pitch"=>Tensor::from_array(([1,frames],pitch)).map_err(onnx)?,
                "pitchf"=>Tensor::from_array(([1,frames],pitchf)).map_err(onnx)?,
                "ds"=>Tensor::from_array(([1],vec![0_i64])).map_err(onnx)?,
                "rnd"=>Tensor::from_array(([1,192,frames],noise)).map_err(onnx)?
            ])
            .map_err(onnx)?;
        let (_, audio) = output[0].try_extract_tensor::<f32>().map_err(onnx)?;
        if audio.iter().any(|v| !v.is_finite()) {
            return Err(onnx("sortie audio non finie"));
        }
        let out = audio::resample(audio, synth.sample_rate, 48000);
        if out.len() != frames * 480 {
            return Err(onnx(format!(
                "longueur synthèse incorrecte : {} au lieu de {}",
                out.len(),
                frames * 480
            )));
        }
        Ok(out)
    }
}

pub(crate) struct Synthesizer {
    session: Session,
    index: Option<FeatureIndex>,
    sample_rate: u32,
    random: u64,
}
impl Synthesizer {
    pub(crate) fn load(dir: &Path, backend: Backend) -> Result<Self> {
        let meta = crate::models::read_meta(dir)?;
        let session = builder(backend)?
            .commit_from_file(dir.join("model.onnx"))
            .map_err(onnx)?;
        let expected = ["phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd"];
        if session.inputs.len() != expected.len()
            || session.outputs.is_empty()
            || expected
                .iter()
                .any(|name| !session.inputs.iter().any(|input| input.name == *name))
        {
            return Err(onnx("interface du synthétiseur RVC incompatible"));
        }
        let index = if meta.has_index {
            Some(FeatureIndex::load(&dir.join("index.bin"))?)
        } else {
            None
        };
        Ok(Self {
            session,
            index,
            sample_rate: meta.model_sample_rate,
            random: 0x4e6f697365,
        })
    }
    fn noise(&mut self, len: usize) -> Vec<f32> {
        let mut uniform = || {
            self.random ^= self.random << 13;
            self.random ^= self.random >> 7;
            self.random ^= self.random << 17;
            ((self.random >> 40) as f32 + 1.0) / 16777217.0
        };
        (0..len)
            .map(|_| {
                (-2.0 * uniform().ln()).sqrt() * (2.0 * std::f32::consts::PI * uniform()).cos()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Opt in with RVC_TEST_ASSETS and RVC_TEST_MODEL pointing to packaging-time
    /// fetched assets and a converted real public voice. No test downloads weights.
    #[test]
    #[ignore = "requires downloaded ContentVec/RMVPE and a converted real RVC v2 voice"]
    fn real_voice_cpu_rtf() {
        let assets = std::env::var_os("RVC_TEST_ASSETS").expect("RVC_TEST_ASSETS");
        let imports = tempfile::tempdir().unwrap();
        let model = if let Some(pth) = std::env::var_os("RVC_TEST_PTH") {
            let converter = crate::ConverterPaths {
                python_exe: std::env::var_os("RVC_TEST_PYTHON")
                    .expect("RVC_TEST_PYTHON")
                    .into(),
                script: Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../converter/convert_rvc.py"),
            };
            let mut progress = Vec::new();
            let meta = crate::import_model(
                &converter,
                Path::new(&pth),
                None,
                "Voix de test",
                imports.path(),
                &mut |p| progress.push(p),
            )
            .unwrap();
            assert_eq!(progress.last(), Some(&1.0));
            assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
            assert_eq!(crate::list_models(imports.path()).unwrap().len(), 1);
            imports.path().join(meta.id)
        } else {
            PathBuf::from(
                std::env::var_os("RVC_TEST_MODEL").expect("RVC_TEST_MODEL or RVC_TEST_PTH"),
            )
        };
        let mut networks = Networks::load(Path::new(&assets), Backend::Cpu).unwrap();
        let mut synth = Synthesizer::load(&model, Backend::Cpu).unwrap();
        let params = RvcParams::default();
        let samples = (params.block_ms + params.crossfade_ms + 160) as usize * 48;
        let mut total = std::time::Duration::ZERO;
        for block in 0..12 {
            let input: Vec<_> = (0..samples)
                .map(|i| {
                    let t = (i + block * 12000) as f32 / 48000.0;
                    0.12 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                        + 0.04 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
                })
                .collect();
            let start = std::time::Instant::now();
            let output = networks.convert(&mut synth, &input, params).unwrap();
            let elapsed = start.elapsed();
            total += elapsed;
            assert_eq!(output.len(), samples);
            assert!(output.iter().all(|v| v.is_finite()));
            assert!(output.iter().any(|v| v.abs() > 1e-6));
            eprintln!("block {block}: {:.1} ms", elapsed.as_secs_f64() * 1000.0);
        }
        // Each inference emits 250 ms; overlap + retained left context is overhead.
        eprintln!("CPU pipeline: {:.3}s compute / 3.000s emitted = RTF {:.3}; mean {:.1}ms/block; default capture lookahead 300ms",total.as_secs_f64(),total.as_secs_f64()/3.0,total.as_secs_f64()*1000.0/12.0);
    }
}
