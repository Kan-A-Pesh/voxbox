use rustfft::{num_complex::Complex, FftPlanner};

/// Windowed-sinc resampling with a low-pass cutoff when downsampling.
/// Worker-only: all lengths and allocations are independent of the audio callback.
pub(crate) fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    let len = input.len() * to as usize / from as usize;
    let cutoff = (to as f64 / from as f64).min(1.0) * 0.95;
    (0..len)
        .map(|i| {
            let pos = i as f64 * from as f64 / to as f64;
            let center = pos.floor() as isize;
            let mut sum = 0.0;
            let mut weight = 0.0;
            for j in -32..=32 {
                let t = pos - (center + j) as f64;
                let x = std::f64::consts::PI * t * cutoff;
                let sinc = if x.abs() < 1e-10 { 1.0 } else { x.sin() / x };
                let w = sinc * (0.5 + 0.5 * (std::f64::consts::PI * t / 33.0).cos());
                let index = (center + j).clamp(0, input.len().saturating_sub(1) as isize);
                sum += input[index as usize] as f64 * w;
                weight += w;
            }
            (sum / weight) as f32
        })
        .collect()
}

pub(crate) fn blend_head(current: &mut [f32], previous: &[f32]) {
    let n = previous.len().min(current.len());
    for i in 0..n {
        let t = (i + 1) as f32 / (n + 1) as f32;
        let w = 0.5 - 0.5 * (std::f32::consts::PI * t).cos();
        current[i] = previous[i] * (1.0 - w) + current[i] * w;
    }
}

/// RMVPE's HTK mel basis, Slaney area normalization, magnitude STFT,
/// periodic Hann, reflection centering, n_fft=1024, hop=160, fmin=30.
pub(crate) fn log_mel(audio: &[f32]) -> (usize, Vec<f32>) {
    let frames = audio.len() / 160 + 1;
    let padded = frames.div_ceil(32) * 32;
    let mut mel = vec![0.0; 128 * padded];
    let hz_to_mel = |hz: f32| 2595.0 * (1.0 + hz / 700.0).log10();
    let lo = hz_to_mel(30.0);
    let hi = hz_to_mel(8000.0);
    let edges: Vec<f32> = (0..130)
        .map(|i| 700.0 * (10.0_f32.powf((lo + (hi - lo) * i as f32 / 129.0) / 2595.0) - 1.0))
        .collect();
    let basis: Vec<Vec<f32>> = (0..128)
        .map(|m| {
            (0..513)
                .map(|k| {
                    let hz = k as f32 * 16000.0 / 1024.0;
                    ((hz - edges[m]) / (edges[m + 1] - edges[m]))
                        .min((edges[m + 2] - hz) / (edges[m + 2] - edges[m + 1]))
                        .max(0.0)
                        * 2.0
                        / (edges[m + 2] - edges[m])
                })
                .collect()
        })
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(1024);
    let mut buffer = vec![Complex::default(); 1024];
    for frame in 0..frames {
        for (k, value) in buffer.iter_mut().enumerate() {
            let mut index = frame as isize * 160 + k as isize - 512;
            let last = audio.len() as isize - 1;
            while index < 0 || index > last {
                index = if index < 0 { -index } else { 2 * last - index };
            }
            let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * k as f32 / 1024.0).cos();
            *value = Complex::new(audio[index as usize] * hann, 0.0);
        }
        fft.process(&mut buffer);
        for m in 0..128 {
            let energy: f32 = basis[m]
                .iter()
                .zip(&buffer)
                .map(|(w, v)| w * v.norm())
                .sum();
            mel[m * padded + frame] = energy.max(1e-5).ln();
        }
    }
    (padded, mel)
}

pub(crate) fn decode_f0(salience: &[f32], shift: f32) -> Vec<f32> {
    salience
        .as_chunks::<360>()
        .0
        .iter()
        .map(|row| {
            let center = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|x| x.0)
                .unwrap_or(0);
            if row[center] <= 0.03 {
                return 0.0;
            }
            let mut sum = 0.0;
            let mut weight = 0.0;
            for (i, &s) in row
                .iter()
                .enumerate()
                .take((center + 5).min(360))
                .skip(center.saturating_sub(4))
            {
                sum += s * (20.0 * i as f32 + 1997.3794);
                weight += s;
            }
            10.0 * 2.0_f32.powf(sum / weight / 1200.0 + shift / 12.0)
        })
        .collect()
}

pub(crate) fn coarse_f0(f0: f32) -> i64 {
    if f0 <= 0.0 {
        return 1;
    }
    let mel = 1127.0 * (1.0 + f0 / 700.0).ln();
    let min = 1127.0 * (1.0 + 50.0_f32 / 700.0).ln();
    let max = 1127.0 * (1.0 + 1100.0_f32 / 700.0).ln();
    ((mel - min) * 254.0 / (max - min) + 1.0)
        .round()
        .clamp(1.0, 255.0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampling_lengths_and_dc() {
        for rate in [16000, 32000, 40000, 48000] {
            let a = resample(&vec![0.25; 4800], 48000, rate);
            assert_eq!(a.len(), rate as usize / 10);
            assert!(a.iter().all(|v| (v - 0.25).abs() < 1e-5));
            assert_eq!(resample(&a, rate, 48000).len(), 4800);
        }
        assert!(resample(&[], 48000, 16000).is_empty());
    }
    #[test]
    fn antialiasing() {
        let input: Vec<_> = (0..4800)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 12000.0 / 48000.0).sin())
            .collect();
        let out = resample(&input, 48000, 16000);
        let rms = (out[32..out.len() - 32].iter().map(|x| x * x).sum::<f32>()
            / (out.len() - 64) as f32)
            .sqrt();
        assert!(rms < 0.01, "alias RMS {rms}");
    }
    #[test]
    fn crossfade_preserves_dc_and_is_continuous() {
        let mut a = vec![0.25; 480];
        blend_head(&mut a, &vec![0.25; 480]);
        assert!(a.iter().all(|x| (*x - 0.25).abs() < 1e-6));
        let mut a = vec![1.0; 480];
        blend_head(&mut a, &vec![0.0; 480]);
        assert!(a[0] < 0.001 && a[479] > 0.999);
        assert!(a.windows(2).all(|w| (w[1] - w[0]).abs() < 0.004));
    }
    #[test]
    fn pitch_and_mel() {
        assert_eq!(coarse_f0(0.0), 1);
        assert_eq!(coarse_f0(50.0), 1);
        assert_eq!(coarse_f0(1100.0), 255);
        let mut row = vec![0.0; 360];
        row[100] = 1.0;
        let a = decode_f0(&row, 0.0)[0];
        let b = decode_f0(&row, 12.0)[0];
        assert!((b - 2.0 * a).abs() < 0.01);
        let (frames, mel) = log_mel(&vec![0.0; 3200]);
        assert_eq!(frames, 32);
        assert_eq!(mel.len(), 128 * 32);
        assert!((mel[0] - 1e-5_f32.ln()).abs() < 1e-5);
        assert_eq!(mel[31], 0.0); // upstream pads log-mel with zero, not log(0).
    }
}
