use std::f32::consts::TAU;

use crate::{spectral::FormantShift, EffectDescriptor, EffectKind, EffectSpec, SAMPLE_RATE};

const SR: f32 = SAMPLE_RATE as f32;

fn clean_state(x: f32) -> f32 {
    if x.abs() < 1.0e-20 {
        0.0
    } else {
        x
    }
}

fn time_coefficient(ms: f32) -> f32 {
    (-1.0 / (ms * 0.001 * SR)).exp()
}

struct Delay {
    data: Vec<f32>,
    pos: usize,
}

impl Delay {
    fn new(len: usize) -> Self {
        Self {
            data: vec![0.0; len.max(4)],
            pos: 0,
        }
    }

    fn push(&mut self, x: f32) {
        self.data[self.pos] = clean_state(x);
        self.pos += 1;
        if self.pos == self.data.len() {
            self.pos = 0;
        }
    }

    /// Fractional age relative to the last pushed sample; all callers reserve
    /// two guard samples and constrain their delay at construction.
    fn read(&self, age: f32) -> f32 {
        let integer = age as usize;
        let fraction = age - integer as f32;
        let len = self.data.len();
        let offset = self.pos + len - 1 - integer;
        let a = if offset >= len { offset - len } else { offset };
        let b = if a == 0 { len - 1 } else { a - 1 };
        self.data[a] + fraction * (self.data[b] - self.data[a])
    }

    fn integer_age(&self, age: usize) -> f32 {
        let len = self.data.len();
        let offset = self.pos + len - 1 - age;
        self.data[if offset >= len { offset - len } else { offset }]
    }

    fn reset(&mut self) {
        self.data.fill(0.0);
        self.pos = 0;
    }
}

#[derive(Clone, Copy)]
pub(super) struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new(kind: EffectKind, hz: f32, q: f32) -> Self {
        let omega = std::f64::consts::TAU * f64::from(hz) / f64::from(SAMPLE_RATE);
        let (sine, cosine) = omega.sin_cos();
        let alpha = sine / (2.0 * f64::from(q));
        let (b0, b1, b2) = match kind {
            EffectKind::LowPass => ((1.0 - cosine) * 0.5, 1.0 - cosine, (1.0 - cosine) * 0.5),
            EffectKind::HighPass => ((1.0 + cosine) * 0.5, -(1.0 + cosine), (1.0 + cosine) * 0.5),
            _ => (alpha, 0.0, -alpha), // RBJ band-pass, constant 0 dB peak.
        };
        let a0 = 1.0 + alpha;
        Self {
            b0: (b0 / a0) as f32,
            b1: (b1 / a0) as f32,
            b2: (b2 / a0) as f32,
            a1: (-2.0 * cosine / a0) as f32,
            a2: ((1.0 - alpha) / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = clean_state(self.b1 * x - self.a1 * y + self.z2);
        self.z2 = clean_state(self.b2 * x - self.a2 * y);
        y
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

pub(super) struct Oscillator {
    phase: f32,
    increment: f32,
}
impl Oscillator {
    fn new(hz: f32) -> Self {
        Self {
            phase: 0.0,
            increment: hz / SR,
        }
    }
    fn sine(&mut self) -> f32 {
        let out = (TAU * self.phase).sin();
        self.phase += self.increment;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        out
    }
}

/// Two Hann-windowed variable-delay heads. Autocorrelation aligns the window
/// to an even number of voiced periods to suppress beating on sustained vowels.
/// The read rate is 2^(semitones/12); crossfades conceal delay-line wraps.
pub(super) struct PitchShift {
    delay: Delay,
    ratio: f32,
    phase: f32,
    window: f32,
    target_window: f32,
    analysis_count: usize,
}

impl PitchShift {
    const MAX_AGE: usize = 1376;
    fn new(semitones: f32) -> Self {
        Self {
            delay: Delay::new(2048),
            ratio: 2.0_f32.powf(semitones / 12.0),
            phase: 0.0,
            window: 960.0,
            target_window: 960.0,
            analysis_count: 0,
        }
    }

    fn analyse_period(&mut self) {
        // Decimation is used only for pitch detection, never in the signal path.
        let mut energy = 0.0;
        for n in (0..384).step_by(4) {
            energy += self.delay.integer_age(n).powi(2);
        }
        if energy < 0.0001 {
            return;
        }
        let mut best_lag = 0_usize;
        let mut best_score = 0.75;
        for lag in (80..=600).step_by(4) {
            let mut cross = 0.0;
            let mut previous_energy = 0.0;
            for n in (0..384).step_by(4) {
                let a = self.delay.integer_age(n);
                let b = self.delay.integer_age(n + lag);
                cross += a * b;
                previous_energy += b * b;
            }
            let score = cross / (energy * previous_energy + 1.0e-16).sqrt();
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
            // Prefer the fundamental over an equally strong period multiple.
            if score > 0.985 {
                break;
            }
        }
        if best_lag == 0 {
            return;
        }
        let mut refined = best_lag;
        let mut best_error = f32::MAX;
        for lag in best_lag.saturating_sub(3)..=best_lag + 3 {
            let mut error = 0.0;
            for n in (0..384).step_by(4) {
                let d = self.delay.integer_age(n) - self.delay.integer_age(n + lag);
                error += d * d;
            }
            if error < best_error {
                best_error = error;
                refined = lag;
            }
        }
        let period_pair = 2.0 * refined as f32;
        self.target_window =
            (period_pair * (960.0 / period_pair).round().max(1.0)).clamp(640.0, 1344.0);
    }

    fn tick(&mut self, x: f32) -> f32 {
        self.delay.push(x);
        self.analysis_count += 1;
        if self.analysis_count == 960 {
            self.analyse_period();
            self.analysis_count = 0;
        }
        // Bound window motion so tracking cannot cause abrupt pitch jumps.
        self.window += (self.target_window - self.window).clamp(-0.02, 0.02);
        self.phase += (1.0 - self.ratio) / self.window;
        if self.phase < 0.0 {
            self.phase += 1.0;
        }
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        let phase2 = if self.phase >= 0.5 {
            self.phase - 0.5
        } else {
            self.phase + 0.5
        };
        let weight = 0.5 - 0.5 * (TAU * self.phase).cos();
        let a = self.delay.read(32.0 + self.phase * self.window);
        let b = self.delay.read(32.0 + phase2 * self.window);
        weight * a + (1.0 - weight) * b
    }

    fn reset(&mut self) {
        self.delay.reset();
        self.phase = 0.0;
        self.window = 960.0;
        self.target_window = 960.0;
        self.analysis_count = 0;
    }
}

pub(super) struct ModulatedDelay {
    delay: Delay,
    oscillator: Oscillator,
    base: f32,
    depth: f32,
    mix: f32,
    latency: usize,
}
impl ModulatedDelay {
    fn vibrato(rate: f32, semitones: f32) -> Self {
        let depth = (2.0_f32.powf(semitones / 12.0) - 1.0) * SR / (TAU * rate);
        let base = depth + 2.0;
        Self {
            delay: Delay::new((base + depth).ceil() as usize + 4),
            oscillator: Oscillator::new(rate),
            base,
            depth,
            mix: 1.0,
            latency: base.ceil() as usize,
        }
    }
    fn chorus(rate: f32, depth_ms: f32, mix: f32) -> Self {
        let depth = depth_ms * SR / 1000.0;
        Self {
            delay: Delay::new((720.0 + depth).ceil() as usize + 4),
            oscillator: Oscillator::new(rate),
            base: 720.0,
            depth,
            mix,
            latency: 0,
        }
    }
    fn tick(&mut self, x: f32) -> f32 {
        self.delay.push(x);
        let age = self.base + self.depth * self.oscillator.sine();
        let wet = self.delay.read(age);
        x + self.mix * (wet - x)
    }
    fn reset(&mut self) {
        self.delay.reset();
        self.oscillator.phase = 0.0;
    }
}

pub(super) struct Echo {
    delay: Delay,
    age: f32,
    feedback: f32,
    mix: f32,
}
impl Echo {
    fn new(ms: f32, feedback: f32, mix: f32) -> Self {
        let age = ms * SR / 1000.0;
        Self {
            delay: Delay::new(age.ceil() as usize + 4),
            age,
            feedback,
            mix,
        }
    }
    fn tick(&mut self, x: f32) -> f32 {
        let delayed = self.delay.read(self.age - 1.0);
        self.delay.push(x + delayed * self.feedback);
        x + self.mix * (delayed - x)
    }
}

struct Comb {
    data: Vec<f32>,
    pos: usize,
    filtered: f32,
}
impl Comb {
    fn new(len: usize) -> Self {
        Self {
            data: vec![0.0; len],
            pos: 0,
            filtered: 0.0,
        }
    }
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let out = self.data[self.pos];
        self.filtered = clean_state(out * (1.0 - damp) + self.filtered * damp);
        self.data[self.pos] = clean_state(x + self.filtered * feedback);
        self.pos += 1;
        if self.pos == self.data.len() {
            self.pos = 0;
        }
        out
    }
    fn allpass(&mut self, x: f32) -> f32 {
        let delayed = self.data[self.pos];
        let out = delayed - x;
        self.data[self.pos] = clean_state(x + delayed * 0.5);
        self.pos += 1;
        if self.pos == self.data.len() {
            self.pos = 0;
        }
        out
    }
    fn reset(&mut self) {
        self.data.fill(0.0);
        self.pos = 0;
        self.filtered = 0.0;
    }
}

/// Freeverb topology: eight damped parallel combs, four serial diffusers.
pub(super) struct Reverb {
    combs: [Comb; 8],
    allpasses: [Comb; 4],
    feedback: f32,
    damping: f32,
    mix: f32,
}
impl Reverb {
    fn new(room: f32, damp: f32, mix: f32) -> Self {
        Self {
            combs: [1215, 1293, 1390, 1476, 1548, 1623, 1695, 1760].map(Comb::new),
            allpasses: [605, 480, 371, 245].map(Comb::new),
            feedback: 0.7 + room * 0.27,
            damping: damp * 0.85,
            mix,
        }
    }
    fn tick(&mut self, x: f32) -> f32 {
        let mut wet = 0.0;
        for comb in &mut self.combs {
            wet += comb.tick(x * 0.035, self.feedback, self.damping);
        }
        for diffuser in &mut self.allpasses {
            wet = diffuser.allpass(wet);
        }
        x + self.mix * (wet - x)
    }
    fn reset(&mut self) {
        for comb in &mut self.combs {
            comb.reset();
        }
        for diffuser in &mut self.allpasses {
            diffuser.reset();
        }
    }
}

struct WhisperBand {
    analysis: Biquad,
    synthesis: Biquad,
    envelope: f32,
}
pub(super) struct Whisper {
    bands: [WhisperBand; 8],
    amount: f32,
    random: u32,
}
impl Whisper {
    fn new(amount: f32) -> Self {
        Self {
            bands: [160.0, 300.0, 550.0, 900.0, 1500.0, 2500.0, 4000.0, 6500.0].map(|hz| {
                let filter = Biquad::new(EffectKind::BandPass, hz, 1.0);
                WhisperBand {
                    analysis: filter,
                    synthesis: filter,
                    envelope: 0.0,
                }
            }),
            amount,
            random: 0x9e37_79b9,
        }
    }
    fn tick(&mut self, x: f32) -> f32 {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        let noise = self.random as f32 * (2.0 / u32::MAX as f32) - 1.0;
        let mut wet = 0.0;
        for band in &mut self.bands {
            let magnitude = band.analysis.tick(x).abs();
            let coefficient = if magnitude > band.envelope {
                0.993
            } else {
                0.998
            };
            band.envelope = clean_state(magnitude + coefficient * (band.envelope - magnitude));
            wet += band.synthesis.tick(noise) * band.envelope * 3.0;
        }
        x + self.amount * (wet - x)
    }
    fn reset(&mut self) {
        self.random = 0x9e37_79b9;
        for band in &mut self.bands {
            band.analysis.reset();
            band.synthesis.reset();
            band.envelope = 0.0;
        }
    }
}

pub(super) struct Dynamics {
    threshold: f32,
    ratio_exponent: f32,
    makeup: f32,
    envelope: f32,
    gain: f32,
    attack: f32,
    release: f32,
    gate: bool,
    open: bool,
}
impl Dynamics {
    fn gate(db: f32) -> Self {
        Self {
            threshold: 10.0_f32.powf(db / 20.0),
            ratio_exponent: 0.0,
            makeup: 1.0,
            envelope: 0.0,
            gain: 0.0,
            attack: time_coefficient(1.0),
            release: time_coefficient(30.0),
            gate: true,
            open: false,
        }
    }
    fn compressor(db: f32, ratio: f32, makeup_db: f32) -> Self {
        Self {
            threshold: 10.0_f32.powf(db / 20.0),
            ratio_exponent: 1.0 / ratio - 1.0,
            makeup: 10.0_f32.powf(makeup_db / 20.0),
            envelope: 0.0,
            gain: 1.0,
            attack: time_coefficient(5.0),
            release: time_coefficient(80.0),
            gate: false,
            open: false,
        }
    }
    fn tick(&mut self, x: f32) -> f32 {
        let magnitude = x.abs();
        let coefficient = if magnitude > self.envelope {
            self.attack
        } else {
            self.release
        };
        self.envelope = clean_state(magnitude + coefficient * (self.envelope - magnitude));
        let target = if self.gate {
            if self.envelope > self.threshold {
                self.open = true;
            }
            if self.envelope < self.threshold * 0.6 {
                self.open = false;
            }
            if self.open {
                1.0
            } else {
                0.0
            }
        } else if self.envelope > self.threshold {
            (self.envelope / self.threshold).powf(self.ratio_exponent)
        } else {
            1.0
        };
        let smoothing = if self.gate {
            if target > self.gain {
                self.attack
            } else {
                self.release
            }
        } else if target < self.gain {
            self.attack
        } else {
            self.release
        };
        self.gain = clean_state(target + smoothing * (self.gain - target));
        x * self.gain * self.makeup
    }
    fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain = if self.gate { 0.0 } else { 1.0 };
        self.open = false;
    }
}

pub(super) struct Bitcrush {
    scale: f32,
    interval: usize,
    remaining: usize,
    held: f32,
}
pub(super) struct Robot {
    delay: Delay,
    age: f32,
    dc: f32,
}
impl Robot {
    fn tick(&mut self, x: f32) -> f32 {
        let resonant = self.delay.read(self.age - 1.0);
        // Rectification excites the fixed comb harmonics even for low voices.
        let magnitude = x.abs();
        self.dc = clean_state(self.dc + 0.005 * (magnitude - self.dc));
        let excitation = magnitude - self.dc;
        self.delay.push(excitation + resonant * 0.86);
        (resonant - excitation) * 0.65 + x * 0.25
    }
}

// The enum is kept private: callers can only build fully validated states.
pub(crate) enum Effect {
    Bypass,
    Pitch(Box<PitchShift>),
    Formant(Box<FormantShift>),
    Gain(f32),
    Filter(Biquad),
    Distortion { drive: f32, norm: f32, mix: f32 },
    Bitcrush(Bitcrush),
    Ring { oscillator: Oscillator, mix: f32 },
    Tremolo { oscillator: Oscillator, depth: f32 },
    Modulation(ModulatedDelay),
    Echo(Echo),
    Reverb(Box<Reverb>),
    Robot(Robot),
    Whisper(Box<Whisper>),
    Dynamics(Dynamics),
}

impl Effect {
    pub(crate) fn new(spec: &EffectSpec, descriptor: &EffectDescriptor) -> Self {
        // Every key below is declared by the matching catalog entry. Invalid
        // persisted floating-point values use the editor default as well.
        let p = |key: &str| {
            descriptor
                .params
                .iter()
                .find(|d| d.key == key)
                .map_or(0.0, |d| {
                    let value = spec.params.get(key).copied().unwrap_or(d.default);
                    if value.is_nan() {
                        d.default
                    } else {
                        value.clamp(d.min, d.max)
                    }
                })
        };
        use EffectKind::*;
        match spec.kind {
            PitchShift if p("semitones").abs() < 0.0001 => Self::Bypass,
            PitchShift => Self::Pitch(Box::new(crate::effects::PitchShift::new(p("semitones")))),
            FormantShift if p("semitones").abs() < 0.0001 => Self::Bypass,
            FormantShift => {
                Self::Formant(Box::new(crate::spectral::FormantShift::new(p("semitones"))))
            }
            Gain => Self::Gain(10.0_f32.powf(p("db") / 20.0)),
            LowPass | HighPass | BandPass => {
                Self::Filter(Biquad::new(spec.kind, p("cutoffHz"), p("q")))
            }
            Distortion => Self::Distortion {
                drive: p("drive"),
                norm: 1.0 / p("drive").tanh(),
                mix: p("mix"),
            },
            Bitcrush => Self::Bitcrush(crate::effects::Bitcrush {
                scale: 2.0_f32.powf(p("bits").round() - 1.0) - 1.0,
                interval: p("downsample").round() as usize,
                remaining: 0,
                held: 0.0,
            }),
            RingMod => Self::Ring {
                oscillator: Oscillator::new(p("freqHz")),
                mix: p("mix"),
            },
            Tremolo => Self::Tremolo {
                oscillator: Oscillator::new(p("rateHz")),
                depth: p("depth"),
            },
            Vibrato if p("depthSemitones") == 0.0 => Self::Bypass,
            Vibrato => Self::Modulation(ModulatedDelay::vibrato(p("rateHz"), p("depthSemitones"))),
            Echo => Self::Echo(crate::effects::Echo::new(
                p("delayMs"),
                p("feedback"),
                p("mix"),
            )),
            Reverb => Self::Reverb(Box::new(crate::effects::Reverb::new(
                p("roomSize"),
                p("damping"),
                p("mix"),
            ))),
            Chorus => Self::Modulation(ModulatedDelay::chorus(p("rateHz"), p("depthMs"), p("mix"))),
            Robotize => Self::Robot(Robot {
                age: SR / p("freqHz"),
                dc: 0.0,
                delay: Delay::new((SR / p("freqHz")).ceil() as usize + 4),
            }),
            Whisper => Self::Whisper(Box::new(crate::effects::Whisper::new(p("amount")))),
            NoiseGate => Self::Dynamics(Dynamics::gate(p("thresholdDb"))),
            Compressor => Self::Dynamics(Dynamics::compressor(
                p("thresholdDb"),
                p("ratio"),
                p("makeupDb"),
            )),
        }
    }

    pub(crate) fn process(&mut self, buf: &mut [f32]) {
        match self {
            Self::Bypass => {}
            Self::Pitch(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Formant(s) => s.process(buf),
            Self::Gain(gain) => {
                for x in buf {
                    *x *= *gain;
                }
            }
            Self::Filter(filter) => {
                for x in buf {
                    *x = filter.tick(*x);
                }
            }
            Self::Distortion { drive, norm, mix } => {
                for x in buf {
                    *x += *mix * ((*x * *drive).tanh() * *norm - *x);
                }
            }
            Self::Bitcrush(s) => {
                for x in buf {
                    if s.remaining == 0 {
                        s.held = (*x * s.scale).round() / s.scale;
                        s.remaining = s.interval;
                    }
                    s.remaining -= 1;
                    *x = s.held;
                }
            }
            Self::Ring { oscillator, mix } => {
                for x in buf {
                    *x *= 1.0 - *mix + *mix * oscillator.sine();
                }
            }
            Self::Tremolo { oscillator, depth } => {
                for x in buf {
                    *x *= 1.0 - *depth * 0.5 * (1.0 + oscillator.sine());
                }
            }
            Self::Modulation(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Echo(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Reverb(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Robot(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Whisper(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
            Self::Dynamics(s) => {
                for x in buf {
                    *x = s.tick(*x);
                }
            }
        }
    }

    pub(crate) fn reset(&mut self) {
        match self {
            Self::Pitch(s) => s.reset(),
            Self::Formant(s) => s.reset(),
            Self::Filter(s) => s.reset(),
            Self::Bitcrush(s) => {
                s.remaining = 0;
                s.held = 0.0;
            }
            Self::Ring { oscillator, .. } | Self::Tremolo { oscillator, .. } => {
                oscillator.phase = 0.0
            }
            Self::Modulation(s) => s.reset(),
            Self::Echo(s) => s.delay.reset(),
            Self::Reverb(s) => s.reset(),
            Self::Robot(s) => {
                s.delay.reset();
                s.dc = 0.0;
            }
            Self::Whisper(s) => s.reset(),
            Self::Dynamics(s) => s.reset(),
            _ => {}
        }
    }

    pub(crate) fn latency_samples(&self) -> usize {
        match self {
            Self::Pitch(_) => PitchShift::MAX_AGE,
            Self::Formant(_) => FormantShift::LATENCY,
            Self::Modulation(s) => s.latency,
            _ => 0,
        }
    }
}
