//! Extraction of an RVC model archive: its largest `.pth`.
//!
//! The archive's `.index` is deliberately left out: the converter reads it with
//! `faiss.read_index`, a native deserializer that is not safe on untrusted input, whereas the
//! checkpoint is loaded with `torch.load(weights_only=True)`.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::{Result, VoiceModelsError};

/// Uncompressed bytes extracted from one archive.
pub const MAX_EXTRACTED_BYTES: u64 = 2_000_000_000;
/// A model archive holds a handful of files. `zip` keeps every entry's name, extra field and
/// comment (each up to 64 KiB) in memory whatever the declared directory size, so the entry
/// count is what truly bounds that metadata: at most 256 × (46 + 3 × 65 535) bytes ≈ 48 MiB.
/// Checked on every end record `zip` may use, before `ZipArchive::new`.
pub const MAX_ENTRIES: u64 = 256;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
const EOCD_LEN: usize = 22;
/// Same probed region as zip 9.8's reader: an end record, its signature, and a 64 KiB comment.
const EOCD_SEARCH_LEN: u64 = EOCD_LEN as u64 + 4 + (1 << 16);

/// Extracts the largest `.pth` of `zip_path` into `dest_dir/model.pth` and returns that path.
///
/// Files may sit in subfolders. An archive holding any entry whose path escapes its root
/// (`..`, absolute path) is refused as a whole.
pub fn extract_model(zip_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let mut file = File::open(zip_path)?;
    check_central_directory(&mut file)?;
    let mut archive = ZipArchive::new(file).map_err(archive_error)?;

    let mut pth: Option<(usize, u64)> = None;
    for position in 0..archive.len() {
        let entry = archive.by_index(position).map_err(archive_error)?;
        let Some(path) = entry.enclosed_name() else {
            return Err(VoiceModelsError::UnsafeArchive);
        };
        if entry.is_dir() {
            continue;
        }
        let is_pth = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pth"));
        if is_pth && pth.is_none_or(|(_, size)| entry.size() > size) {
            pth = Some((position, entry.size()));
        }
    }

    let Some((pth_position, pth_size)) = pth else {
        return Err(VoiceModelsError::NoModelInArchive);
    };
    if pth_size > MAX_EXTRACTED_BYTES {
        return Err(VoiceModelsError::ExtractedTooLarge);
    }

    fs::create_dir_all(dest_dir)?;
    let pth_path = dest_dir.join("model.pth");
    write_entry(&mut archive, pth_position, &pth_path, MAX_EXTRACTED_BYTES)?;
    Ok(pth_path)
}

/// Copies one entry, never writing more than `limit` bytes whatever its header declares.
fn write_entry(
    archive: &mut ZipArchive<File>,
    position: usize,
    destination: &Path,
    limit: u64,
) -> Result<()> {
    let entry = archive.by_index(position).map_err(archive_error)?;
    let mut output = File::create(destination)?;
    let written = io::copy(&mut entry.take(limit + 1), &mut output)
        .map_err(|error| VoiceModelsError::Archive(error.to_string()))?;
    if written > limit {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(VoiceModelsError::ExtractedTooLarge);
    }
    Ok(())
}

/// Bounds the entry count and directory size of every end-of-central-directory record the
/// `zip` reader may pick (it probes the same tail region and can fall back to earlier records),
/// so a decoy record in the archive comment cannot hide the real one.
///
/// Zip64 is refused outright: `zip` switches to a zip64 record only for an end record with a
/// saturated field, and an RVC model archive (well under 4 GB) never needs one. Refusing those
/// layouts guarantees the directory `zip` reads is one checked here.
fn check_central_directory(file: &mut File) -> Result<()> {
    let length = file.seek(SeekFrom::End(0))?;
    let tail_len = length.min(EOCD_SEARCH_LEN);
    file.seek(SeekFrom::Start(length - tail_len))?;
    let mut tail = Vec::with_capacity(tail_len as usize);
    file.by_ref().take(tail_len).read_to_end(&mut tail)?;

    let mut found = false;
    for position in (0..tail.len().saturating_sub(EOCD_LEN - 1)).rev() {
        if &tail[position..position + 4] != EOCD_SIGNATURE {
            continue;
        }
        found = true;
        let record = &tail[position..position + EOCD_LEN];
        let field16 = |at: usize| u16::from_le_bytes([record[at], record[at + 1]]);
        let field32 = |at: usize| {
            u32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]])
        };
        let (entries_here, entries, directory, offset) =
            (field16(8), field16(10), field32(12), field32(16));
        if entries_here == u16::MAX
            || entries == u16::MAX
            || directory == u32::MAX
            || offset == u32::MAX
        {
            return Err(VoiceModelsError::Archive(
                "les archives zip64 ne sont pas prises en charge".into(),
            ));
        }
        check_bounds(u64::from(entries), u64::from(directory))?;
    }
    if !found {
        return Err(VoiceModelsError::Archive(
            "fin de répertoire central introuvable".into(),
        ));
    }
    Ok(())
}

fn check_bounds(entries: u64, directory: u64) -> Result<()> {
    if entries > MAX_ENTRIES || directory > MAX_CENTRAL_DIRECTORY_BYTES {
        return Err(VoiceModelsError::TooManyEntries);
    }
    Ok(())
}

fn archive_error(error: zip::result::ZipError) -> VoiceModelsError {
    VoiceModelsError::Archive(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::extract_model;
    use crate::VoiceModelsError;

    fn build_zip(dir: &std::path::Path, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = dir.join("model.zip");
        let mut writer = ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, data) in entries {
            if name.ends_with('/') {
                writer
                    .add_directory(*name, SimpleFileOptions::default())
                    .unwrap();
            } else {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(data).unwrap();
            }
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn extracts_only_the_largest_pth_from_a_subfolder() {
        let dir = tempdir().unwrap();
        let zip = build_zip(
            dir.path(),
            &[
                ("Voice/", b""),
                ("Voice/G_2333.pth", b"small"),
                ("Voice/voice.pth", b"the real model weights"),
                ("Voice/added_IVF.index", b"index-bytes"),
                ("__MACOSX/Voice/._voice.pth", b"x"),
                ("readme.txt", b"hello"),
            ],
        );
        let out = dir.path().join("out");
        let pth = extract_model(&zip, &out).unwrap();
        assert_eq!(std::fs::read(&pth).unwrap(), b"the real model weights");
        // The untrusted FAISS index is never written out.
        let written: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(written, vec![std::ffi::OsString::from("model.pth")]);
    }

    #[test]
    fn the_extension_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let zip = build_zip(dir.path(), &[("Model.PTH", b"weights")]);
        let pth = extract_model(&zip, &dir.path().join("out")).unwrap();
        assert_eq!(std::fs::read(pth).unwrap(), b"weights");
    }

    #[test]
    fn refuses_an_archive_without_pth() {
        let dir = tempdir().unwrap();
        let zip = build_zip(dir.path(), &[("model.index", b"index")]);
        assert!(matches!(
            extract_model(&zip, &dir.path().join("out")),
            Err(VoiceModelsError::NoModelInArchive)
        ));
    }

    #[test]
    fn refuses_path_traversal() {
        let dir = tempdir().unwrap();
        let zip = build_zip(dir.path(), &[("../evil.pth", b"x"), ("ok.pth", b"y")]);
        let out = dir.path().join("out");
        assert!(matches!(
            extract_model(&zip, &out),
            Err(VoiceModelsError::UnsafeArchive)
        ));
        assert!(!dir.path().join("evil.pth").exists());
        assert!(!out.join("model.pth").exists());
    }

    /// An empty archive whose end record declares `entries` entries: never opened by `zip`.
    fn eocd_only(entries: u16, directory: u32) -> Vec<u8> {
        let mut bytes = b"PK\x05\x06\0\0\0\0".to_vec();
        bytes.extend(entries.to_le_bytes());
        bytes.extend(entries.to_le_bytes());
        bytes.extend(directory.to_le_bytes());
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(0_u16.to_le_bytes());
        bytes
    }

    #[test]
    fn refuses_huge_central_directories_before_opening_them() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.zip");
        for (entries, directory) in [(60_000, 1_000), (257, 1_000), (10, 200_000_000)] {
            std::fs::write(&path, eocd_only(entries, directory)).unwrap();
            assert!(matches!(
                extract_model(&path, &dir.path().join("out")),
                Err(VoiceModelsError::TooManyEntries)
            ));
        }
    }

    #[test]
    fn up_to_256_entries_pass_the_directory_check() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.zip");
        // Within bounds: refused later by `zip` (no directory behind it), not as too many entries.
        std::fs::write(&path, eocd_only(256, 1_000)).unwrap();
        assert!(matches!(
            extract_model(&path, &dir.path().join("out")),
            Err(VoiceModelsError::Archive(_))
        ));
    }

    #[test]
    fn refuses_zip64_layouts_whatever_their_records_declare() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.zip");
        // A zip64 end record + locator declaring few entries, behind a saturated classic record:
        // refused before any of them is read.
        let mut bytes = b"PK\x06\x06".to_vec();
        bytes.extend(44_u64.to_le_bytes());
        bytes.extend([45, 0, 45, 0]);
        bytes.extend([0; 8]);
        bytes.extend(1_u64.to_le_bytes());
        bytes.extend(1_u64.to_le_bytes());
        bytes.extend(10_u64.to_le_bytes());
        bytes.extend(0_u64.to_le_bytes());
        bytes.extend(b"PK\x06\x07\0\0\0\0");
        bytes.extend(0_u64.to_le_bytes());
        bytes.extend(1_u32.to_le_bytes());
        for (entries, directory) in [(u16::MAX, 10), (1, u32::MAX)] {
            let mut archive = bytes.clone();
            archive.extend(eocd_only(entries, directory));
            std::fs::write(&path, archive).unwrap();
            assert!(matches!(
                extract_model(&path, &dir.path().join("out")),
                Err(VoiceModelsError::Archive(m)) if m.contains("zip64")
            ));
        }
    }

    #[test]
    fn a_decoy_end_record_in_the_comment_does_not_hide_the_real_one() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.zip");
        // Real record declares 60 000 entries; its comment holds a harmless-looking record.
        let decoy = eocd_only(1, 10);
        let mut bytes = eocd_only(60_000, 1_000);
        let len = bytes.len();
        bytes[len - 2..].copy_from_slice(&(decoy.len() as u16).to_le_bytes());
        bytes.extend(decoy);
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            extract_model(&path, &dir.path().join("out")),
            Err(VoiceModelsError::TooManyEntries)
        ));
    }

    #[test]
    fn refuses_a_file_that_is_not_a_zip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.zip");
        std::fs::write(&path, b"<html>Google Drive</html>").unwrap();
        assert!(matches!(
            extract_model(&path, &dir.path().join("out")),
            Err(VoiceModelsError::Archive(_))
        ));
    }
}
