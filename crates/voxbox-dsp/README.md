# VoxBox DSP

Mono, 48 kHz, arbitrary in-place block lengths. Construct `VoiceChain` away from
an audio callback, move it to that callback, then call `process`/`reset` without
allocation or locking. Parameters are read once at construction, defaulted and
clamped against the same French catalog the editor uses. Rebuild a chain when
parameters change. Disabled effects are skipped. Non-finite input becomes silence;
a soft limiter has unity gain up to 0.8 and bounds output to [-1, 1].

## Algorithms and delays

| Effect | Algorithm | Reported processing delay |
| --- | --- | --- |
| pitchShift | Two overlapping Hann grains, fractional delay interpolation, autocorrelation-guided period alignment | 1376 samples maximum look-back (28.67 ms); zero at 0 semitones |
| formantShift | 1024-point, 256-hop sqrt-Hann WOLA; shift the smoothed log spectral envelope while preserving complex phase/bin frequencies | 1024 samples (21.33 ms); zero at 0 semitones |
| gain | Linear gain derived from dB | 0 |
| lowPass, highPass, bandPass | RBJ biquads, double-precision coefficient design, transposed direct form II | 0 (frequency-dependent filter phase is not an inserted buffering delay) |
| distortion | Normalized tanh soft clipping, dry/wet mix | 0 |
| bitcrush | Symmetric quantization and sample-and-hold | 0 |
| ringMod | Sine carrier multiplication with dry/wet mix | 0 |
| tremolo | Sine amplitude modulation | 0 |
| vibrato | Fractional variable delay; excursion derived from rate and semitone depth | ceil(2 + (2^(depth/12)-1) × 48000/(2π × rate)) samples; 0 at depth 0 |
| echo | Feedback fractional delay | 0; wet echo starts at delayMs |
| reverb | Freeverb topology, eight parallel damped combs and four serial all-pass diffusers, scaled for 48 kHz | 0; wet onset starts after 1215 samples |
| chorus | Sine-modulated fractional delay around 15 ms, dry/wet mix | 0; wet delay is 15 ms ± depthMs |
| robotize | DC-rejected rectification excites a feedback comb tuned to freqHz; partial dry speech maintains intelligibility | 0; resonant period is 48000/freqHz samples |
| whisper | Eight-band noise vocoder with per-band speech envelopes and matched noise synthesis filters | 0 (causal envelope response) |
| noiseGate | Peak envelope, hysteresis, 1 ms opening and 30 ms closing | 0 |
| compressor | Peak envelope, 5 ms attack/80 ms release, ratio gain curve and makeup gain | 0 |

Pitch shifting uses a varying read delay, so it does not have one exact fixed
latency; the reported value is a conservative bound. Formant and vibrato delays
add to it in a chain. Delay/reverb/chorus wet paths are musical effects rather
than an inserted delay of the full dry signal. Tail duration is not latency.

The short granular pitch shifter favors speech and latency over studio-quality
polyphonic music. Period tracking operates on voiced fundamentals around
80–600 Hz, with crossfaded grains on unvoiced input. It can introduce texture on
transients or very low voices. Spectral-envelope formant shifting is approximate,
particularly on high voices with sparse harmonics. Both require listening on real
speech for subjective tuning; numeric tests cannot establish perceptual quality.
The masculine/feminine presets are stylized pitch/timbre changes, not AI models.

## Listen

```sh
cargo run -p voxbox-dsp --release --example render -- villager in.wav out.wav
```

The example accepts integer or float WAV input at 48 kHz, averages channels to
mono, writes 32-bit float mono, and appends two seconds of tail. It preserves the
initial effect delay so transients are not cropped using an approximate latency.
Long cathedral tails may extend beyond the two-second audition tail.

## Validate

```sh
cargo test -p voxbox-dsp
cargo clippy -p voxbox-dsp --all-targets -- -D warnings
cargo fmt -p voxbox-dsp --check
cargo test -p voxbox-dsp --release --test dsp preset_performance -- --ignored --nocapture
```

The ignored release benchmark processes ten seconds of deterministic speech-like
audio per preset on one thread, excludes construction and signal generation from
timing, prints each duration/latency, and asserts a duration below 200 ms.
On Linux it uses `/proc/thread-self/schedstat` for the single-thread CPU budget,
excluding time descheduled behind other sandbox workers, and reports wall time
alongside it. On other systems (or without scheduler accounting), the budget
uses wall time. This distinction matters on this shared build sandbox.
Allocation counting is thread-local so parallel test harness activity cannot mask
or fabricate callback allocations; it includes the first FFT frame and reset.

Dependencies: `serde` preserves the shared UI/engine JSON contract; `rustfft`
provides pure Rust FFT plans with caller-owned scratch buffers, avoiding a custom
FFT implementation and allocation in the audio callback. `hound` is dev-only WAV
I/O for the audition example; `serde_json` is dev-only contract verification.
No native libraries, FFI, devices or network access are required at runtime.

## Measured release performance

AMD EPYC 7402, x86_64 Linux, Rust 1.99.1; 480,000 speech-like samples per voice,
480-sample calls, one processing thread. Numbers exclude construction. These
were measured while other workers compiled on the same shared sandbox; wall
times include their CPU contention. Every voice is below the 200 ms CPU budget.
A dedicated-machine wall-time limit still needs validation.

| Preset | CPU ms / 10 s | Wall ms / 10 s | Delay samples |
| --- | ---: | ---: | ---: |
| villager | 64.997 | 82.892 | 2400 |
| robot | 10.901 | 75.186 | 0 |
| demon | 77.511 | 315.947 | 2400 |
| chipmunk | 66.745 | 188.290 | 2400 |
| giant | 77.125 | 399.091 | 2400 |
| radio | 12.279 | 53.768 | 0 |
| telephone | 12.352 | 25.431 | 0 |
| cathedral | 14.250 | 29.153 | 0 |
| alien | 70.562 | 108.387 | 2400 |
| ghost | 38.760 | 48.678 | 47 |
| gas-mask | 29.380 | 100.770 | 0 |
| male-to-female | 63.523 | 105.702 | 2400 |
| female-to-male | 69.382 | 163.622 | 2400 |
| megaphone | 5.404 | 15.656 | 0 |
| underwater | 15.707 | 40.788 | 104 |
| cave | 15.892 | 15.782 | 0 |
| baby | 61.676 | 90.547 | 2400 |
| old-man | 72.277 | 316.549 | 2421 |
| zombie | 68.336 | 246.093 | 2400 |
| crystal | 37.835 | 78.925 | 1376 |
| retro-8bit | 2.821 | 9.719 | 0 |
| whisper | 32.592 | 69.819 | 0 |
