use crate::{AiModelMeta, ConverterPaths, Result, RvcError};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

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

pub(crate) fn parse_progress(line: &str) -> Option<f32> {
    let value: f32 = line.trim().strip_prefix("PROGRESS ")?.parse().ok()?;
    (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
}

pub fn import_model(
    converter: &ConverterPaths,
    pth: &Path,
    index: Option<&Path>,
    name: &str,
    models_dir: &Path,
    progress: &mut dyn FnMut(f32),
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
        let status = child.wait()?;
        let stderr = errors
            .join()
            .map_err(|_| RvcError::Conversion("lecture stderr interrompue".into()))??;
        if let Some(e) = read_error {
            return Err(e.into());
        }
        if !status.success() {
            return Err(RvcError::Conversion(format!("{status}: {stderr}")));
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
