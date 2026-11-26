use crate::{AiModelMeta, ConverterPaths, Result, RvcError};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// A conversion takes a few minutes on CPU: past this, the converter is killed (hung or fed a
/// checkpoint that makes it work forever).
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(20 * 60);

pub(crate) fn read_meta(dir: &Path) -> Result<AiModelMeta> {
    let meta: AiModelMeta = serde_json::from_slice(&fs::read(dir.join("meta.json"))?)
        .map_err(|e| RvcError::Conversion(format!("meta.json : {e}")))?;
    if meta.id.is_empty()
        || !meta
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || meta.name.trim().is_empty()
        || !matches!(meta.model_sample_rate, 32000 | 40000 | 48000)
    {
        return Err(RvcError::Conversion("métadonnées RVC invalides".into()));
    }
    if !dir.join("model.onnx").is_file() || (meta.has_index && !dir.join("index.bin").is_file()) {
        return Err(RvcError::ModelNotFound(dir.to_path_buf()));
    }
    Ok(meta)
}

pub fn list_models(models_dir: &Path) -> Result<Vec<AiModelMeta>> {
    if !models_dir.exists() {
        return Ok(Vec::new());
    }
    let mut models = Vec::new();
    for entry in fs::read_dir(models_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let meta = read_meta(&entry.path())?;
        if entry.file_name() != meta.id.as_str() {
            return Err(RvcError::Conversion(
                "identifiant différent du dossier du modèle".into(),
            ));
        }
        models.push(meta);
    }
    models.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(models)
}

/// Polls without holding the lock, so the watchdog can still kill the child meanwhile.
fn wait_child(child: &Mutex<Child>) -> Result<std::process::ExitStatus> {
    loop {
        let exited = child
            .lock()
            .map_err(|_| RvcError::Conversion("processus de conversion inaccessible".into()))?
            .try_wait()?;
        if let Some(status) = exited {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// API level declared by the installed converter script (`CONVERTER_API = <n>` on its own line),
/// or 0 for a script that predates it. Older AI packs keep their script across app updates.
pub fn converter_api(script: &Path) -> u32 {
    let Ok(source) = fs::read_to_string(script) else {
        return 0;
    };
    source
        .lines()
        .find_map(|line| line.strip_prefix("CONVERTER_API = "))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

pub(crate) fn parse_progress(line: &str) -> Option<f32> {
    let value: f32 = line.trim().strip_prefix("PROGRESS ")?.parse().ok()?;
    (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
}

/// Imports a checkpoint the user picked on their own machine (legacy PyTorch format accepted).
pub fn import_model(
    converter: &ConverterPaths,
    pth: &Path,
    index: Option<&Path>,
    name: &str,
    models_dir: &Path,
    progress: &mut dyn FnMut(f32),
) -> Result<AiModelMeta> {
    import_model_within(
        converter,
        pth,
        index,
        name,
        models_dir,
        progress,
        CONVERSION_TIMEOUT,
        false,
    )
}

/// Imports a checkpoint downloaded from an unknown source: the converter runs with
/// `--untrusted`: PyTorch >= 2.10, zip format only, directory and metadata sizes bounded before
/// PyTorch reads them, tensors memory-mapped, and an OS memory ceiling (4 GiB: a Windows job
/// object, `RLIMIT_AS` elsewhere) set before the checkpoint is loaded. Needs `converter_api` >= 3.
/// An online archive's `.index` is never imported.
pub fn import_online_model(
    converter: &ConverterPaths,
    pth: &Path,
    name: &str,
    models_dir: &Path,
    progress: &mut dyn FnMut(f32),
) -> Result<AiModelMeta> {
    import_model_within(
        converter,
        pth,
        None,
        name,
        models_dir,
        progress,
        CONVERSION_TIMEOUT,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn import_model_within(
    converter: &ConverterPaths,
    pth: &Path,
    index: Option<&Path>,
    name: &str,
    models_dir: &Path,
    progress: &mut dyn FnMut(f32),
    timeout: Duration,
    untrusted: bool,
) -> Result<AiModelMeta> {
    if !pth.is_file() || index.is_some_and(|p| !p.is_file()) {
        return Err(RvcError::ModelNotFound(pth.to_path_buf()));
    }
    if name.trim().is_empty() {
        return Err(RvcError::Conversion("nom vide".into()));
    }
    fs::create_dir_all(models_dir)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| RvcError::Conversion(e.to_string()))?
        .as_nanos();
    let id = format!(
        "rvc-{stamp:x}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let staging = models_dir.join(format!(".import-{id}"));
    fs::create_dir(&staging)?;
    let mut run = || -> Result<AiModelMeta> {
        let mut command = Command::new(&converter.python_exe);
        command
            .arg("-I")
            .arg("-B")
            .arg("-X")
            .arg("utf8")
            .arg(&converter.script)
            .arg("--pth")
            .arg(pth)
            .arg("--output")
            .arg(&staging)
            .arg("--id")
            .arg(&id)
            .arg("--name")
            .arg(name.trim())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = index {
            command.arg("--index").arg(index);
        }
        if untrusted {
            command.arg("--untrusted");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for the embedded console interpreter.
        }
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RvcError::Conversion("stdout absent".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| RvcError::Conversion("stderr absent".into()))?;
        let errors = std::thread::spawn(move || -> std::io::Result<String> {
            let mut tail = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = stderr.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..n]);
                if tail.len() > 16384 {
                    tail.drain(..tail.len() - 16384);
                }
            }
            Ok(String::from_utf8_lossy(&tail).into_owned())
        });
        // Kills the converter past `timeout`, until it has exited: a converter that closes its
        // stdout and keeps running is killed too.
        let child = Arc::new(Mutex::new(child));
        let (finished, wait_finish) = mpsc::channel::<()>();
        let watchdog = {
            let child = Arc::clone(&child);
            std::thread::spawn(move || {
                let expired = matches!(
                    wait_finish.recv_timeout(timeout),
                    Err(mpsc::RecvTimeoutError::Timeout)
                );
                if expired {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                    }
                }
                expired
            })
        };
        let mut last = 0.0;
        let mut read_error = None;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if let Some(p) = parse_progress(&line) {
                        if p >= last && p < 1.0 {
                            progress(p);
                            last = p;
                        }
                    }
                }
                Err(e) => {
                    read_error = Some(e);
                    break;
                }
            }
        }
        // Disarm the watchdog only once the process has exited, not at stdout EOF.
        let status = wait_child(&child);
        let _ = finished.send(());
        let timed_out = watchdog.join().map_err(|_| {
            RvcError::Conversion("surveillance de la conversion interrompue".into())
        })?;
        let status = status?;
        let stderr = errors
            .join()
            .map_err(|_| RvcError::Conversion("lecture stderr interrompue".into()))??;
        if timed_out {
            return Err(RvcError::Conversion(format!(
                "conversion arrêtée après {} minutes sans se terminer",
                timeout.as_secs() / 60
            )));
        }
        if let Some(e) = read_error {
            return Err(e.into());
        }
        if !status.success() {
            // The whole converter output goes to voxbox.log, where it can be copied.
            tracing::error!(
                "conversion de « {} » échouée ({status}) :\n{stderr}",
                name.trim()
            );
            return Err(RvcError::Conversion(format!("{status}: {stderr}")));
        }
        if !stderr.trim().is_empty() {
            tracing::info!("convertisseur (« {} ») :\n{stderr}", name.trim());
        }
        let meta = read_meta(&staging)?;
        if meta.id != id || meta.builtin {
            return Err(RvcError::Conversion(
                "identifiant ou statut builtin invalide".into(),
            ));
        }
        fs::rename(&staging, models_dir.join(&id))?;
        progress(1.0);
        Ok(meta)
    };
    let result = run();
    if result.is_err() {
        fs::remove_dir_all(&staging)?;
    }
    result
}

/// VOXIDX01, u32 little-endian dimensions (768), u32 vector count, then
/// row-major float32 little-endian vectors. Max 4096 centroids (~12 MiB).
pub(crate) struct FeatureIndex {
    vectors: Vec<f32>,
}
impl FeatureIndex {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(17 + 4096 * 768 * 4)
            .read_to_end(&mut bytes)?;
        if !(16..=16 + 4096 * 768 * 4).contains(&bytes.len()) {
            return Err(RvcError::Conversion("taille index invalide".into()));
        }
        if &bytes[..8] != b"VOXIDX01" {
            return Err(RvcError::Conversion("format index invalide".into()));
        }
        let u32_at = |offset| {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        let dim = u32_at(8);
        let count = u32_at(12);
        if dim != 768 || count == 0 || count > 4096 || bytes.len() != 16 + count as usize * 768 * 4
        {
            return Err(RvcError::Conversion("dimensions index invalides".into()));
        }
        let vectors: Vec<f32> = bytes[16..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if vectors.iter().any(|v| !v.is_finite()) {
            return Err(RvcError::Conversion("index non fini".into()));
        }
        Ok(Self { vectors })
    }
    pub(crate) fn blend(&self, features: &mut [f32], rate: f32) {
        if rate == 0.0 {
            return;
        }
        for frame in features.as_chunks_mut::<768>().0 {
            let mut nearest = [(f32::INFINITY, 0usize); 8];
            for (i, vector) in self.vectors.as_chunks::<768>().0.iter().enumerate() {
                let distance = vector
                    .iter()
                    .zip(frame.iter())
                    .map(|(a, b)| (a - b) * (a - b))
                    .sum::<f32>();
                if distance < nearest[7].0 {
                    nearest[7] = (distance, i);
                    nearest.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
                }
            }
            let mut result = [0.0; 768];
            let mut total = 0.0;
            for (distance, i) in nearest {
                if !distance.is_finite() {
                    continue;
                }
                // RVC's squared inverse squared-L2 distance weighting.
                let weight = 1.0 / (distance.max(1e-6).powi(2));
                total += weight;
                for (out, &value) in result.iter_mut().zip(&self.vectors[i * 768..(i + 1) * 768]) {
                    *out += weight * value;
                }
            }
            for (value, retrieved) in frame.iter_mut().zip(result) {
                *value = *value * (1.0 - rate) + retrieved / total * rate;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn a_hung_converter_is_killed_after_the_timeout() {
        // Stands in for python: ignores its arguments and never finishes.
        assert_hung_converter_is_killed("#!/bin/sh\nexec sleep 30\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_converter_that_closes_stdout_and_hangs_is_killed_too() {
        assert_hung_converter_is_killed("#!/bin/sh\nexec >&-\nexec sleep 30\n");
    }

    #[cfg(unix)]
    fn assert_hung_converter_is_killed(script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let python = dir.path().join("python");
        fs::write(&python, script).unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        let pth = dir.path().join("model.pth");
        fs::write(&pth, b"weights").unwrap();
        let models = dir.path().join("models");
        let converter = ConverterPaths {
            python_exe: python,
            script: dir.path().join("convert_rvc.py"),
        };
        let started = std::time::Instant::now();
        let result = super::import_model_within(
            &converter,
            &pth,
            None,
            "Voix",
            &models,
            &mut |_| {},
            Duration::from_millis(300),
            false,
        );
        assert!(
            matches!(&result, Err(RvcError::Conversion(m)) if m.contains("arrêtée")),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(fs::read_dir(&models).unwrap().count(), 0, "staging removed");
    }

    #[cfg(unix)]
    #[test]
    fn only_an_online_import_runs_the_converter_untrusted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let python = dir.path().join("python");
        // Stands in for python: reports its arguments, then fails.
        fs::write(&python, "#!/bin/sh\necho \"args: $*\" >&2\nexit 1\n").unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        let pth = dir.path().join("model.pth");
        fs::write(&pth, b"weights").unwrap();
        let models = dir.path().join("models");
        let converter = ConverterPaths {
            python_exe: python,
            script: dir.path().join("convert_rvc.py"),
        };
        let local = super::import_model(&converter, &pth, None, "Voix", &models, &mut |_| {});
        assert!(
            matches!(&local, Err(RvcError::Conversion(m)) if m.contains("args:") && !m.contains("--untrusted")),
            "{local:?}"
        );
        let online = super::import_online_model(&converter, &pth, "Voix", &models, &mut |_| {});
        assert!(
            matches!(&online, Err(RvcError::Conversion(m)) if m.contains("--untrusted")),
            "{online:?}"
        );
    }

    #[test]
    fn reads_the_converter_api_level() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("convert_rvc.py");
        assert_eq!(super::converter_api(&script), 0, "missing script");
        fs::write(&script, "import sys\n").unwrap();
        assert_eq!(super::converter_api(&script), 0, "older script");
        fs::write(&script, "import sys\nCONVERTER_API = 2\nVENDOR = 1\n").unwrap();
        assert_eq!(super::converter_api(&script), 2);
        let repo_script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../converter/convert_rvc.py");
        assert!(super::converter_api(&repo_script) >= 3, "shipped converter");
    }

    #[test]
    fn progress_rejects_invalid_values() {
        assert_eq!(parse_progress("PROGRESS 0.42\n"), Some(0.42));
        for s in [
            "PROGRESS NaN",
            "PROGRESS inf",
            "PROGRESS -0.1",
            "PROGRESS 1.1",
            "message 0.4",
        ] {
            assert_eq!(parse_progress(s), None);
        }
    }
    #[test]
    fn list_and_metadata() {
        let temp = tempfile::tempdir().unwrap();
        assert!(list_models(temp.path()).unwrap().is_empty());
        let dir = temp.path().join("test");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("model.onnx"), []).unwrap();
        fs::write(dir.join("meta.json"),r#"{"id":"test","name":"Essai","modelSampleRate":40000,"hasIndex":false,"builtin":false}"#).unwrap();
        let meta = list_models(temp.path()).unwrap();
        assert_eq!(meta[0].license, None);
        assert_eq!(meta[0].model_sample_rate, 40000);
        fs::create_dir(temp.path().join(".import-pending")).unwrap();
        assert_eq!(list_models(temp.path()).unwrap().len(), 1);
        fs::write(dir.join("meta.json"),r#"{"id":"../escape","name":"Essai","modelSampleRate":40000,"hasIndex":false,"builtin":false}"#).unwrap();
        assert!(list_models(temp.path()).is_err());
    }
    #[test]
    fn index_roundtrip_and_nearest() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let mut data = b"VOXIDX01".to_vec();
        data.extend(768u32.to_le_bytes());
        data.extend(2u32.to_le_bytes());
        for v in [0.0f32, 10.0] {
            for _ in 0..768 {
                data.extend(v.to_le_bytes());
            }
        }
        fs::write(tmp.path(), &data).unwrap();
        let index = FeatureIndex::load(tmp.path()).unwrap();
        let mut frame = vec![0.01; 768];
        index.blend(&mut frame, 1.0);
        assert!(frame[0] < 0.001);
        let mut frame = vec![3.0; 768];
        index.blend(&mut frame, 0.0);
        assert_eq!(frame[0], 3.0);
        data.pop();
        fs::write(tmp.path(), data).unwrap();
        assert!(FeatureIndex::load(tmp.path()).is_err());
    }
}
