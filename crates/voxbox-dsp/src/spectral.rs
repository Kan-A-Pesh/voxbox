use std::sync::Arc;

use rustfft::{num_complex::Complex32, Fft, FftPlanner};

/// Short-time spectral-envelope warping. Only magnitudes are corrected: complex
/// phases and harmonic bin locations stay intact, so fundamental pitch is not
/// transposed. Two box-smoothing passes suppress harmonic structure before the
/// envelope is sampled at f/ratio. This is an approximate formant transform,
/// especially for very high fundamentals (few harmonics per formant).
pub(crate) struct FormantShift {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    scratch: Vec<Complex32>,
    spectrum: Vec<Complex32>,
    input: Vec<f32>,
    output: Vec<f32>,
    window: Vec<f32>,
    envelope: Vec<f32>,
    smoothed: Vec<f32>,
    input_pos: usize,
    output_pos: usize,
    hop_count: usize,
    ratio: f32,
}

impl FormantShift {
    const N: usize = 1024;
    const HOP: usize = 256;
    const BINS: usize = Self::N / 2 + 1;
    pub(crate) const LATENCY: usize = Self::N;

    pub(crate) fn new(semitones: f32) -> Self {
        let mut planner = FftPlanner::new();
        let forward = planner.plan_fft_forward(Self::N);
        let inverse = planner.plan_fft_inverse(Self::N);
        let scratch_len = forward
            .get_inplace_scratch_len()
            .max(inverse.get_inplace_scratch_len());
        Self {
            forward,
            inverse,
            scratch: vec![Complex32::default(); scratch_len],
            spectrum: vec![Complex32::default(); Self::N],
            input: vec![0.0; Self::N],
            output: vec![0.0; Self::N * 2],
            window: (0..Self::N)
                .map(|i| {
                    (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / Self::N as f32).cos()).sqrt()
                })
                .collect(),
            envelope: vec![0.0; Self::BINS],
            smoothed: vec![0.0; Self::BINS],
            input_pos: 0,
            output_pos: 0,
            hop_count: 0,
            ratio: 2.0_f32.powf(semitones / 12.0),
        }
    }

    fn frame(&mut self) {
        for i in 0..Self::N {
            self.spectrum[i] = Complex32::new(
                self.input[(self.input_pos + i) % Self::N] * self.window[i],
                0.0,
            );
        }
        self.forward
            .process_with_scratch(&mut self.spectrum, &mut self.scratch);
        for i in 0..Self::BINS {
            self.envelope[i] = self.spectrum[i].norm().max(1.0e-8).ln();
        }
        // ~470 Hz smoothing span at 48 kHz; suppresses harmonic ripples while
        // retaining the broad resonances of the vocal tract. Sliding sums are O(N).
        for _ in 0..2 {
            let mut sum = 0.0;
            let mut start = 0;
            let mut end = 0;
            for i in 0..Self::BINS {
                let next_start = i.saturating_sub(5);
                let next_end = (i + 6).min(Self::BINS);
                while end < next_end {
                    sum += self.envelope[end];
                    end += 1;
                }
                while start < next_start {
                    sum -= self.envelope[start];
                    start += 1;
                }
                self.smoothed[i] = sum / (end - start) as f32;
            }
            self.envelope.copy_from_slice(&self.smoothed);
        }
        for i in 1..Self::N / 2 {
            let source = (i as f32 / self.ratio).min((Self::BINS - 1) as f32);
            let index = source as usize;
            let next = (index + 1).min(Self::BINS - 1);
            let desired = self.envelope[index]
                + (source - index as f32) * (self.envelope[next] - self.envelope[index]);
            // Avoid amplifying spectral nulls/noise, and preserve the sub-150 Hz
            // fundamental region rather than applying a broad bass tilt to it.
            let blend = (i as f32 / 3.2).min(1.0);
            let gain = ((desired - self.envelope[i]) * blend)
                .clamp(-1.6, 1.6)
                .exp();
            self.spectrum[i] *= gain;
            self.spectrum[Self::N - i] *= gain;
        }
        self.inverse
            .process_with_scratch(&mut self.spectrum, &mut self.scratch);
        for i in 0..Self::N {
            let index = (self.output_pos + 1 + i) % self.output.len();
            // sqrt-Hann × sqrt-Hann, four overlaps => COLA gain of two.
            self.output[index] += self.spectrum[i].re * self.window[i] / (Self::N as f32 * 2.0);
        }
    }

    pub(crate) fn process(&mut self, buf: &mut [f32]) {
        for x in buf {
            self.input[self.input_pos] = *x;
            self.input_pos = (self.input_pos + 1) % Self::N;
            *x = self.output[self.output_pos];
            self.output[self.output_pos] = 0.0;
            self.hop_count += 1;
            if self.hop_count == Self::HOP {
                self.frame();
                self.hop_count = 0;
            }
            self.output_pos = (self.output_pos + 1) % self.output.len();
        }
    }

    pub(crate) fn reset(&mut self) {
        self.input.fill(0.0);
        self.output.fill(0.0);
        self.spectrum.fill(Complex32::default());
        self.scratch.fill(Complex32::default());
        self.envelope.fill(0.0);
        self.smoothed.fill(0.0);
        self.input_pos = 0;
        self.output_pos = 0;
        self.hop_count = 0;
    }
}
