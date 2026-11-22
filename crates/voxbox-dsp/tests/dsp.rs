use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    f32::consts::TAU,
};

use rustfft::{num_complex::Complex32, FftPlanner};
use voxbox_dsp::*;

thread_local! {
    static TRACK_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}
struct CountingAllocator;
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
fn record_allocation() {
    if TRACK_ALLOCATIONS.try_with(Cell::get).unwrap_or(false) {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
    }
}
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

fn spec(kind: EffectKind, params: &[(&str, f32)]) -> EffectSpec {
    EffectSpec {
        kind,
        params: params.iter().map(|(k, v)| ((*k).into(), *v)).collect(),
        enabled: true,
    }
}
fn sine(hz: f32, len: usize) -> Vec<f32> {
    (0..len)
        .map(|i| 0.2 * (TAU * hz * i as f32 / SAMPLE_RATE as f32).sin())
        .collect()
}
fn speech(len: usize) -> Vec<f32> {
    (0..len)
        .map(|i| {
            let t = i as f32 / SAMPLE_RATE as f32;
            let fundamental = 130.0 + 8.0 * (TAU * 0.7 * t).sin();
            let mut signal = 0.0;
            for harmonic in 1..=30 {
                let freq = fundamental * harmonic as f32;
                let envelope = (-((freq - 700.0) / 180.0).powi(2)).exp()
                    + 0.7 * (-((freq - 1500.0) / 250.0).powi(2)).exp()
                    + 0.4 * (-((freq - 2600.0) / 400.0).powi(2)).exp()
                    + 0.03;
                signal += (TAU * freq * t).sin() * envelope * 0.04;
            }
            signal * (0.35 + 0.65 * (TAU * 2.1 * t).sin().abs())
        })
        .collect()
}
fn noise(len: usize) -> Vec<f32> {
    let mut state = 1234567_u32;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32 * 1.2 - 0.6
        })
        .collect()
}
fn run(chain: &mut VoiceChain, samples: &mut [f32]) {
    // Deliberately exercise non-power-of-two, empty and sub-hop lengths.
    chain.process(&mut []);
    for block in samples.chunks_mut(137) {
        chain.process(block);
    }
}
fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}
fn spectrum(samples: &[f32]) -> Vec<f32> {
    let n = 32768.min(samples.len());
    let mut data: Vec<_> = samples[samples.len() - n..]
        .iter()
        .enumerate()
        .map(|(i, x)| Complex32::new(x * (0.5 - 0.5 * (TAU * i as f32 / n as f32).cos()), 0.0))
        .collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut data);
    data[..n / 2].iter().map(|v| v.norm()).collect()
}
fn peak_frequency(samples: &[f32]) -> f32 {
    let spectrum = spectrum(samples);
    let bin = (20..spectrum.len() / 3)
        .max_by(|a, b| spectrum[*a].total_cmp(&spectrum[*b]))
        .unwrap();
    bin as f32 * SAMPLE_RATE as f32 / (spectrum.len() * 2) as f32
}
fn valid(samples: &[f32], context: &str) {
    for (i, x) in samples.iter().enumerate() {
        assert!(
            x.is_finite() && (-1.0..=1.0).contains(x),
            "{context} [{i}] = {x}"
        );
    }
}
const KINDS: [EffectKind; 18] = [
    EffectKind::PitchShift,
    EffectKind::FormantShift,
    EffectKind::Gain,
    EffectKind::LowPass,
    EffectKind::HighPass,
    EffectKind::BandPass,
    EffectKind::Distortion,
    EffectKind::Bitcrush,
    EffectKind::RingMod,
    EffectKind::Tremolo,
    EffectKind::Vibrato,
    EffectKind::Echo,
    EffectKind::Reverb,
    EffectKind::Chorus,
    EffectKind::Robotize,
    EffectKind::Whisper,
    EffectKind::NoiseGate,
    EffectKind::Compressor,
];

#[test]
fn octave_transposition_has_the_required_frequency() {
    for (semitones, expected) in [(12.0, 440.0), (-12.0, 110.0)] {
        let mut audio = sine(220.0, SAMPLE_RATE as usize * 2);
        run(
            &mut VoiceChain::new(&[spec(EffectKind::PitchShift, &[("semitones", semitones)])]),
            &mut audio,
        );
        let measured = peak_frequency(&audio);
        assert!(
            (measured / expected - 1.0).abs() < 0.025,
            "{semitones}: expected {expected}, got {measured}"
        );
        assert!(
            rms(&audio[audio.len() / 2..]) > 0.06,
            "pitch shifter must not mute the signal"
        );
    }
}

#[test]
fn formant_shift_preserves_pitch_and_changes_vowel_envelope() {
    for semitones in [-7.0, 7.0] {
        let mut tone = sine(220.0, 48000);
        run(
            &mut VoiceChain::new(&[spec(EffectKind::FormantShift, &[("semitones", semitones)])]),
            &mut tone,
        );
        assert!((peak_frequency(&tone) / 220.0 - 1.0).abs() < 0.02);
    }
    let input: Vec<f32> = (0..48000)
        .map(|i| {
            (1..=50)
                .map(|h| {
                    let f = h as f32 * 100.0;
                    let amp = 0.005 + 0.05 * (-((f - 700.0) / 170.0).powi(2)).exp();
                    amp * (TAU * f * i as f32 / 48000.0).sin()
                })
                .sum()
        })
        .collect();
    let band_ratio = |audio: &[f32]| {
        let spectrum = spectrum(audio);
        let energy = |low: f32, high: f32| {
            spectrum
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    let hz = *i as f32 * 48000.0 / (spectrum.len() * 2) as f32;
                    hz >= low && hz <= high
                })
                .map(|(_, v)| v * v)
                .sum::<f32>()
        };
        energy(850.0, 1150.0) / energy(500.0, 750.0)
    };
    let original = band_ratio(&input);
    let mut raised = input.clone();
    run(
        &mut VoiceChain::new(&[spec(EffectKind::FormantShift, &[("semitones", 5.0)])]),
        &mut raised,
    );
    let mut lowered = input;
    run(
        &mut VoiceChain::new(&[spec(EffectKind::FormantShift, &[("semitones", -5.0)])]),
        &mut lowered,
    );
    assert!(
        band_ratio(&raised) > original * 2.0,
        "formant increase must move resonance energy upward"
    );
    assert!(
        band_ratio(&lowered) < original * 0.8,
        "formant decrease must move resonance energy downward: original={original}, shifted={}",
        band_ratio(&lowered)
    );
}

#[test]
fn catalog_is_complete_and_defaults_are_well_formed() {
    let catalog = effect_catalog();
    assert_eq!(catalog.len(), KINDS.len());
    for kind in KINDS {
        assert_eq!(catalog.iter().filter(|d| d.kind == kind).count(), 1);
    }
    for descriptor in catalog {
        assert!(!descriptor.label.is_empty() && !descriptor.description.is_empty());
        let mut keys = BTreeSet::new();
        for p in descriptor.params {
            assert!(keys.insert(p.key));
            assert!(p.min < p.max && p.default >= p.min && p.default <= p.max && p.step > 0.0);
            assert!(!p.label.is_empty());
        }
    }
}

#[test]
fn every_effect_at_parameter_extremes_is_bounded_and_not_silent() {
    let mut input = noise(6000);
    input.extend(speech(6000));
    for descriptor in effect_catalog() {
        for setting in 0..3 {
            let params = descriptor
                .params
                .iter()
                .map(|p| {
                    (
                        p.key.to_string(),
                        match setting {
                            0 => p.min,
                            1 => p.default,
                            _ => p.max,
                        },
                    )
                })
                .collect();
            let mut output = input.clone();
            if descriptor.kind == EffectKind::Echo {
                output.resize(60000, 0.0);
            }
            let mut chain = VoiceChain::new(&[EffectSpec {
                kind: descriptor.kind,
                params,
                enabled: true,
            }]);
            run(&mut chain, &mut output);
            valid(
                &output,
                &format!("{:?}, setting {setting}", descriptor.kind),
            );
            // A -36 dB gain and a -60 dB compressor are quiet, not disconnected.
            assert!(
                (descriptor.kind == EffectKind::NoiseGate && setting == 2) || rms(&output) > 1.0e-6,
                "{:?}, setting {setting} muted",
                descriptor.kind
            );
        }
    }
}

#[test]
fn all_presets_are_bounded_recognisable_transforms() {
    let mut input = speech(12000);
    input.extend(noise(12000));
    for preset in builtin_presets() {
        let mut output = input.clone();
        run(&mut VoiceChain::new(&preset.effects), &mut output);
        valid(&output, &preset.id);
        assert!(rms(&output) > 0.001, "{} is silent", preset.id);
        let difference: Vec<_> = output.iter().zip(&input).map(|(a, b)| a - b).collect();
        assert!(rms(&difference) > 0.005, "{} is a passthrough", preset.id);
    }
}

#[test]
fn silence_and_reset_clear_every_effect_and_preset() {
    let specs: Vec<Vec<EffectSpec>> = KINDS
        .iter()
        .map(|kind| vec![spec(*kind, &[])])
        .chain(builtin_presets().into_iter().map(|p| p.effects))
        .collect();
    for effects in specs {
        let mut chain = VoiceChain::new(&effects);
        let mut zero = vec![0.0; 12000];
        run(&mut chain, &mut zero);
        assert!(zero.iter().all(|x| x.abs() < 1.0e-7));
        chain.reset();
        let mut first = speech(4096);
        let input = first.clone();
        run(&mut chain, &mut first);
        chain.reset();
        let mut second = input;
        run(&mut chain, &mut second);
        assert_eq!(
            first, second,
            "reset must reproduce a fresh chain: {effects:?}"
        );
        chain.reset();
        run(&mut chain, &mut zero);
        assert!(
            zero.iter().all(|x| x.abs() < 1.0e-7),
            "reset left a tail: {effects:?}"
        );
    }
}

#[test]
fn process_and_reset_allocate_nothing_including_first_fft_frame() {
    // Both transposition directions, all parameter maxima and every preset.
    let mut chains: Vec<_> = effect_catalog()
        .into_iter()
        .map(|d| {
            let params = d.params.iter().map(|p| (p.key.into(), p.max)).collect();
            VoiceChain::new(&[EffectSpec {
                kind: d.kind,
                params,
                enabled: true,
            }])
        })
        .chain(
            builtin_presets()
                .iter()
                .map(|p| VoiceChain::new(&p.effects)),
        )
        .collect();
    let mut block = [0.05; 480];
    ALLOCATIONS.set(0);
    TRACK_ALLOCATIONS.set(true);
    for chain in &mut chains {
        for _ in 0..10 {
            chain.process(&mut block);
        }
        chain.reset();
        chain.process(&mut []);
    }
    TRACK_ALLOCATIONS.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn serde_contract_is_exact() {
    let effect = spec(EffectKind::PitchShift, &[("semitones", 3.0)]);
    let json = r#"{"kind":"pitchShift","params":{"semitones":3.0},"enabled":true}"#;
    assert_eq!(serde_json::to_string(&effect).unwrap(), json);
    assert_eq!(serde_json::from_str::<EffectSpec>(json).unwrap(), effect);
    let defaults: EffectSpec = serde_json::from_str(r#"{"kind":"pitchShift"}"#).unwrap();
    assert!(defaults.enabled && defaults.params.is_empty());
    for preset in builtin_presets() {
        let value = serde_json::to_value(&preset).unwrap();
        assert_eq!(value["aiModelId"], serde_json::Value::Null);
        assert_eq!(value["builtin"], true);
        assert_eq!(
            serde_json::from_value::<VoicePreset>(value).unwrap(),
            preset
        );
    }
}

#[test]
fn builtins_have_the_exact_ids_icons_and_categories() {
    let expected = [
        ("villager", "home"),
        ("robot", "bot"),
        ("demon", "flame"),
        ("chipmunk", "rabbit"),
        ("giant", "mountain"),
        ("radio", "radio"),
        ("telephone", "phone"),
        ("cathedral", "church"),
        ("alien", "alien"),
        ("ghost", "ghost"),
        ("gas-mask", "shield"),
        ("male-to-female", "sparkles"),
        ("female-to-male", "crown"),
        ("megaphone", "megaphone"),
        ("underwater", "bubbles"),
        ("cave", "cave"),
        ("baby", "baby"),
        ("old-man", "hourglass"),
        ("zombie", "skull"),
        ("crystal", "snowflake"),
        ("retro-8bit", "tv"),
        ("whisper", "wave"),
    ];
    let presets = builtin_presets();
    assert_eq!(presets.len(), 22);
    let actual: BTreeMap<_, _> = presets
        .iter()
        .map(|p| (p.id.as_str(), p.icon.as_str()))
        .collect();
    assert_eq!(actual.len(), 22);
    assert_eq!(actual, expected.into_iter().collect());
    for preset in presets {
        assert!(preset.builtin && preset.ai_model_id.is_none() && !preset.effects.is_empty());
        assert_eq!(preset.color.len(), 7);
        assert!(
            preset.color.starts_with('#')
                && preset.color[1..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        let acoustic = [
            "radio",
            "telephone",
            "cathedral",
            "megaphone",
            "underwater",
            "cave",
            "whisper",
        ]
        .contains(&preset.id.as_str());
        assert_eq!(
            preset.category,
            if acoustic {
                VoiceCategory::Effects
            } else {
                VoiceCategory::Fun
            }
        );
        for effect in preset.effects {
            let catalog = effect_catalog();
            let descriptor = catalog.iter().find(|d| d.kind == effect.kind).unwrap();
            for (key, value) in effect.params {
                let p = descriptor
                    .params
                    .iter()
                    .find(|p| p.key == key)
                    .expect("unknown preset parameter");
                assert!(value >= p.min && value <= p.max);
            }
        }
    }
}

#[test]
fn clamping_defaults_disabled_effects_and_hostile_samples_are_safe() {
    let input = noise(4096);
    for d in effect_catalog() {
        let missing = spec(d.kind, &[]);
        let explicit = EffectSpec {
            kind: d.kind,
            params: d.params.iter().map(|p| (p.key.into(), p.default)).collect(),
            enabled: true,
        };
        let invalid = EffectSpec {
            kind: d.kind,
            params: d.params.iter().map(|p| (p.key.into(), f32::NAN)).collect(),
            enabled: true,
        };
        let mut a = input.clone();
        let mut b = input.clone();
        let mut c = input.clone();
        run(&mut VoiceChain::new(&[missing]), &mut a);
        run(&mut VoiceChain::new(&[explicit]), &mut b);
        run(&mut VoiceChain::new(&[invalid]), &mut c);
        assert_eq!(a, b);
        assert_eq!(a, c);
        for (outside, endpoint) in [(f32::NEG_INFINITY, false), (f32::INFINITY, true)] {
            let wild = EffectSpec {
                kind: d.kind,
                params: d.params.iter().map(|p| (p.key.into(), outside)).collect(),
                enabled: true,
            };
            let bounded = EffectSpec {
                kind: d.kind,
                params: d
                    .params
                    .iter()
                    .map(|p| (p.key.into(), if endpoint { p.max } else { p.min }))
                    .collect(),
                enabled: true,
            };
            let mut a = input.clone();
            let mut b = input.clone();
            run(&mut VoiceChain::new(&[wild]), &mut a);
            run(&mut VoiceChain::new(&[bounded]), &mut b);
            assert_eq!(a, b);
        }
        let mut disabled = spec(d.kind, &[]);
        disabled.enabled = false;
        let mut dry = input.clone();
        run(&mut VoiceChain::new(&[disabled]), &mut dry);
        assert_eq!(dry, input);
        let mut hostile = vec![
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::MAX,
            -f32::MAX,
        ];
        hostile.extend(noise(4096));
        run(&mut VoiceChain::new(&[spec(d.kind, &[])]), &mut hostile);
        valid(&hostile, "hostile samples");
    }
}

#[test]
fn processing_is_independent_of_block_boundaries() {
    let input = speech(8192);
    for preset in builtin_presets() {
        let mut a = input.clone();
        let mut b = input.clone();
        let mut chain = VoiceChain::new(&preset.effects);
        chain.process(&mut a);
        run(&mut VoiceChain::new(&preset.effects), &mut b);
        assert_eq!(a, b, "{} depends on block length", preset.id);
    }
}

#[test]
fn filters_and_gain_have_observable_responses() {
    for (kind, pass, stop) in [
        (EffectKind::LowPass, 100.0, 10000.0),
        (EffectKind::HighPass, 10000.0, 100.0),
        (EffectKind::BandPass, 1000.0, 10000.0),
    ] {
        let response = |hz| {
            let mut audio = sine(hz, 8192);
            run(
                &mut VoiceChain::new(&[spec(kind, &[("cutoffHz", 1000.0), ("q", 0.707)])]),
                &mut audio,
            );
            rms(&audio[4096..])
        };
        assert!(
            response(pass) > response(stop) * 8.0,
            "{kind:?} must select frequencies"
        );
    }
    let mut audio = vec![0.1; 1000];
    run(
        &mut VoiceChain::new(&[spec(EffectKind::Gain, &[("db", 6.0206)])]),
        &mut audio,
    );
    assert!((audio[999] - 0.2).abs() < 0.0001);
}

#[test]
fn echo_impulse_appears_at_the_declared_delay() {
    let mut audio = vec![0.0; 20000];
    audio[0] = 0.25;
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Echo,
            &[("delayMs", 100.0), ("feedback", 0.5), ("mix", 1.0)],
        )]),
        &mut audio,
    );
    assert_eq!(audio[0], 0.0);
    assert!((audio[4800] - 0.25).abs() < 1.0e-6);
    assert!((audio[9600] - 0.125).abs() < 1.0e-6);
    assert_eq!(audio.iter().filter(|x| **x != 0.0).count(), 4);
}

#[test]
fn gate_and_compressor_control_levels() {
    let mut quiet = sine(440.0, 24000);
    quiet.iter_mut().for_each(|x| *x *= 0.001);
    run(
        &mut VoiceChain::new(&[spec(EffectKind::NoiseGate, &[("thresholdDb", -40.0)])]),
        &mut quiet,
    );
    assert_eq!(rms(&quiet), 0.0);
    let mut loud = sine(440.0, 24000);
    run(
        &mut VoiceChain::new(&[spec(EffectKind::NoiseGate, &[("thresholdDb", -40.0)])]),
        &mut loud,
    );
    assert!(rms(&loud[12000..]) > 0.12);
    let mut compressed = sine(440.0, 24000);
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Compressor,
            &[("thresholdDb", -30.0), ("ratio", 10.0), ("makeupDb", 0.0)],
        )]),
        &mut compressed,
    );
    assert!(rms(&compressed[12000..]) < 0.05);
}

#[test]
fn latency_is_additive_and_chains_are_send() {
    fn assert_send<T: Send>() {}
    assert_send::<VoiceChain>();
    let pitch = spec(EffectKind::PitchShift, &[("semitones", 3.0)]);
    let formant = spec(EffectKind::FormantShift, &[("semitones", 3.0)]);
    let vibrato = spec(EffectKind::Vibrato, &[]);
    let expected: usize = [&pitch, &formant, &vibrato]
        .iter()
        .map(|s| VoiceChain::new(&[(*s).clone()]).latency_samples())
        .sum();
    assert_eq!(
        VoiceChain::new(&[pitch, formant, vibrato]).latency_samples(),
        expected
    );
    assert!(
        VoiceChain::new(&[spec(EffectKind::PitchShift, &[("semitones", 12.0)])]).latency_samples()
            <= 1440
    );
    assert_eq!(VoiceChain::new(&[]).latency_samples(), 0);
    assert_eq!(
        VoiceChain::new(&[
            spec(EffectKind::PitchShift, &[]),
            spec(EffectKind::FormantShift, &[])
        ])
        .latency_samples(),
        0
    );
}

#[cfg(not(debug_assertions))]
fn thread_cpu_time() -> Option<std::time::Duration> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string("/proc/thread-self/schedstat").ok()?;
        let nanoseconds = stat.split_whitespace().next()?.parse().ok()?;
        Some(std::time::Duration::from_nanos(nanoseconds))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Run explicitly with `cargo test -p voxbox-dsp --release --test dsp preset_performance -- --ignored --nocapture`.
#[test]
#[ignore = "release-only timing benchmark"]
#[cfg(not(debug_assertions))]
fn preset_performance() {
    let input = speech(SAMPLE_RATE as usize * 10);
    let mut slow = Vec::new();
    for preset in builtin_presets() {
        let mut chain = VoiceChain::new(&preset.effects);
        let mut audio = input.clone();
        let cpu_before = thread_cpu_time();
        let start = std::time::Instant::now();
        for block in audio.chunks_mut(BLOCK_SIZE) {
            chain.process(std::hint::black_box(block));
        }
        let wall = start.elapsed();
        let cpu = cpu_before
            .zip(thread_cpu_time())
            .filter(|(before, after)| after > before)
            .map(|(before, after)| after - before);
        let elapsed = cpu.unwrap_or(wall);
        let timer = if cpu.is_some() { "CPU" } else { "wall" };
        std::hint::black_box(&audio);
        println!(
            "{:18} {:8.3} ms {timer}  {:8.3} ms wall   latency {:4} samples",
            preset.id,
            elapsed.as_secs_f64() * 1000.0,
            wall.as_secs_f64() * 1000.0,
            chain.latency_samples()
        );
        if elapsed.as_secs_f64() >= 0.2 {
            slow.push((preset.id, elapsed));
        }
    }
    assert!(slow.is_empty(), "presets over 200 ms: {slow:?}");
}

#[test]
fn distortion_and_bitcrush_have_their_characteristic_transfer_functions() {
    let mut distorted = sine(220.0, 8192);
    let dry_rms = rms(&distorted);
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Distortion,
            &[("drive", 8.0), ("mix", 1.0)],
        )]),
        &mut distorted,
    );
    assert!(rms(&distorted[4096..]) > dry_rms * 2.0);
    let mut stepped = [0.11, 0.22, 0.33, 0.44, -0.11, -0.22, -0.33, -0.44];
    VoiceChain::new(&[spec(
        EffectKind::Bitcrush,
        &[("bits", 3.0), ("downsample", 2.0)],
    )])
    .process(&mut stepped);
    assert_eq!(
        stepped,
        [
            0.0,
            0.0,
            1.0 / 3.0,
            1.0 / 3.0,
            0.0,
            0.0,
            -1.0 / 3.0,
            -1.0 / 3.0
        ]
    );
}

#[test]
fn ring_modulation_creates_sidebands_and_tremolo_changes_amplitude() {
    let mut tone = sine(220.0, 48000);
    run(
        &mut VoiceChain::new(&[spec(EffectKind::RingMod, &[("freqHz", 70.0), ("mix", 1.0)])]),
        &mut tone,
    );
    let peak = peak_frequency(&tone);
    assert!(
        (peak - 150.0).abs() < 3.0 || (peak - 290.0).abs() < 3.0,
        "ring-mod sideband {peak}"
    );
    let mut dc = vec![0.2; 48000];
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Tremolo,
            &[("rateHz", 5.0), ("depth", 1.0)],
        )]),
        &mut dc,
    );
    let min = dc.iter().copied().fold(f32::INFINITY, f32::min);
    let max = dc.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    assert!(min < 0.0001 && max > 0.199 && max <= 0.20001);
}

#[test]
fn vibrato_modulates_instantaneous_frequency() {
    let mut tone = sine(440.0, 48000);
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Vibrato,
            &[("rateHz", 5.0), ("depthSemitones", 1.0)],
        )]),
        &mut tone,
    );
    let crossings: Vec<f32> = (4096..tone.len() - 1)
        .filter(|i| tone[*i] < 0.0 && tone[*i + 1] >= 0.0)
        .map(|i| i as f32 - tone[i] / (tone[i + 1] - tone[i]))
        .collect();
    let frequencies: Vec<f32> = crossings
        .windows(2)
        .map(|w| 48000.0 / (w[1] - w[0]))
        .collect();
    let min = frequencies.iter().copied().fold(f32::INFINITY, f32::min);
    let max = frequencies
        .iter()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max);
    assert!(
        (410.0..430.0).contains(&min) && (455.0..475.0).contains(&max),
        "vibrato range {min}..{max}"
    );
}

#[test]
fn chorus_robot_and_reverb_have_delayed_responses() {
    let mut impulse = vec![0.0; 2000];
    impulse[0] = 0.25;
    let mut chorus = impulse.clone();
    run(
        &mut VoiceChain::new(&[spec(EffectKind::Chorus, &[("depthMs", 0.0), ("mix", 1.0)])]),
        &mut chorus,
    );
    assert_eq!(chorus[720], 0.25);
    assert_eq!(chorus.iter().filter(|x| **x != 0.0).count(), 1);
    for (freq, period) in [(100.0, 480), (200.0, 240)] {
        let mut robot = impulse.clone();
        run(
            &mut VoiceChain::new(&[spec(EffectKind::Robotize, &[("freqHz", freq)])]),
            &mut robot,
        );
        assert!(robot[period] > 0.1);
        assert!(robot[period / 2].abs() < 0.01);
    }
    let mut reverb = vec![0.0; 96000];
    reverb[0] = 0.25;
    run(
        &mut VoiceChain::new(&[spec(
            EffectKind::Reverb,
            &[("roomSize", 0.5), ("damping", 0.5), ("mix", 1.0)],
        )]),
        &mut reverb,
    );
    assert!(reverb[..1215].iter().all(|x| *x == 0.0));
    assert!(reverb.iter().filter(|x| x.abs() > 1.0e-7).count() > 10000);
    assert!(rms(&reverb[72000..]) < rms(&reverb[2400..24000]) * 0.1);
}

#[test]
fn whisper_replaces_periodicity_with_articulated_noise() {
    let mut audio = sine(220.0, 24000);
    audio.resize(48000, 0.0);
    run(
        &mut VoiceChain::new(&[spec(EffectKind::Whisper, &[("amount", 1.0)])]),
        &mut audio,
    );
    let voiced = &audio[4096..20000];
    let lag = 218;
    let cross: f32 = voiced[lag..].iter().zip(voiced).map(|(a, b)| a * b).sum();
    let energy: f32 = voiced.iter().map(|x| x * x).sum();
    assert!(rms(voiced) > 0.005);
    assert!(
        (cross / energy).abs() < 0.5,
        "whisper must remove the periodic excitation"
    );
    assert!(
        rms(&audio[42000..]) < 1.0e-7,
        "whisper must follow the input envelope into silence"
    );
}
