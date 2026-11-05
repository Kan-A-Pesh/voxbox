use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use voxbox_engine::decode_file;
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Wav(PathBuf);
impl Wav {
    fn new(rate: u32, frames: usize) -> Self {
        let path = std::env::temp_dir().join(format!(
            "voxbox-engine-{}-{}.wav",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 2,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..frames {
            let sample =
                ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 12000.0) as i16;
            writer.write_sample(sample).unwrap();
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        Self(path)
    }
}
impl Drop for Wav {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).unwrap();
    }
}
#[test]
fn generated_wav_downmixes_and_resamples_to_exact_duration() {
    for rate in [44_100, 48_000, 96_000, 8_000] {
        let file = Wav::new(rate, rate as usize / 4);
        let decoded = decode_file(&file.0).unwrap();
        assert_eq!(decoded.duration_ms, 250);
        assert_eq!(decoded.samples.len(), 12_000);
        let power = decoded.samples[100..11900]
            .iter()
            .map(|s| s * s)
            .sum::<f32>()
            / 11800.0;
        assert!((power.sqrt() - 12000.0 / 32768.0 / 2.0f32.sqrt()).abs() < 0.005);
    }
}
#[test]
fn rejects_unreadable_and_over_ten_minutes_in_french() {
    let missing = std::env::temp_dir().join("voxbox-engine-missing-input.wav");
    assert!(decode_file(&missing).is_err());
    // A valid WAV header declaring >10 minutes is rejected before decoding payload.
    let file = Wav::new(8_000, 1);
    let mut bytes = std::fs::read(&file.0).unwrap();
    let size = (8_000u32 * 601 * 4).to_le_bytes();
    bytes[40..44].copy_from_slice(&size);
    bytes[4..8].copy_from_slice(&(8_000u32 * 601 * 4 + 36).to_le_bytes());
    std::fs::write(&file.0, bytes).unwrap();
    assert!(decode_file(&file.0)
        .unwrap_err()
        .to_string()
        .contains("10 minutes"));
}
