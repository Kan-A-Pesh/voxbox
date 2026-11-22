# VoxBox audio engine

`Engine` keeps its public contract in `src/lib.rs`. Hardware-free tests use
`graph::Graph`, `graph::Control` and `graph::Settings`.

## Threads and ownership

- CPAL capture callback: converts the negotiated PCM type, averages channels,
  and resamples small chunks into a bounded mono 48 kHz microphone queue.
- Processing worker: consumes 480 samples (10 ms) at a time. It applies RNNoise,
  PTT, optional RVC, the DSP chain, then mixes up to 64 concurrent soundboard
  voices onto separate cable/headset buses and clamps them. A voice change
  crossfades the old/new chains for 10 ms; enabling/disabling also fades.
- Each CPAL render callback independently consumes its bus through a preallocated
  rubato cubic resampler, upmixes to all device channels and converts PCM types.
  A bounded ±0.2% ratio correction follows ring occupancy. After a device stall,
  excessive stale output is discarded; underruns produce silence.
- Control/event thread: owns CPAL streams, forwards control commands through an
  `rtrb` queue, formats events, invokes `EventSink`, and drops retired DSP chains,
  RVC streams and sounds. Engine setters may allocate on their calling control
  thread. An off-audio pending queue preserves commands under backpressure.

`Graph::process` does not allocate, lock, perform I/O, or destroy owned resources.
Commands, events and reclamation queues each hold 256 entries. No resource is
removed from the graph until reclamation space exists. Completed sounds remain
silent in their slots until their final progress/ended events can be delivered.
Telemetry can be skipped when the event consumer lags. Meter/progress cadence is
33.3 Hz. Replay restarts the same sound id without an intermediate ended event.

`nnnoiseless` needs PCM scaled to the signed 16-bit range. Its FFT library caches
plans/scratch in thread-local storage: construction warms the current thread,
and `prepare_thread()` warms a graph after moving it to its processing worker,
before the real-time loop starts. Allocation tests include noise suppression,
voice changes, and sound termination/reclamation.

The worker waits up to 1 ms for capture data **outside** `Graph::process`. Windows
requests a 1 ms multimedia timer period and registers the worker with MMCSS
`Pro Audio`; CPAL's `realtime` feature promotes its hardware callbacks. Both
registrations are restored at shutdown. Failure to obtain scheduling priority
is logged and processing continues at normal priority.

Device changes stop/reopen only hardware streams; the graph, active voices,
settings and sound positions survive. Device errors immediately mark running
false, then emit a French `DeviceError` off the audio thread. An absent cable is
allowed when a headset output exists. Output selection rejects using the same
endpoint for cable and headset, avoiding double playback into the cable. A
system default output that is itself CABLE Input is not opened as a headset.

## Latency target

Capture and graph assembly share the same sample window: at a 5 ms hardware
period two captures assemble one 10 ms block; at a 10 ms period one capture
already contains the entire block. They are not two serial 10 ms buffers.
The estimate reported by `status()` is:

| Stage | Budget |
| --- | ---: |
| Capture + graph block assembly | max(capture period, 10 ms) |
| Output queue / resampler chunk | 5 ms |
| Output device period | negotiated period (requested 5 ms) |
| Worker wake-up + cubic resampler delay allowance | 2 ms |
| **Base target with 5 ms hardware periods** | **22 ms** |
| **Base target with 10 ms WASAPI periods** | **27 ms** |

The capture adapter uses an integral resampling quantum near or below 5 ms
(e.g. 147 frames / 3.33 ms at 44.1 kHz). Polynomial history is primed before
callbacks so a short first resampler output cannot add an entire device period. Audio queues have a
100 ms safety capacity; that is a ceiling, not their target fill. The output
occupancy target is 240 samples (5 ms). Oversized output backlog (>30 ms) is
trimmed to this target. The hardware period is requested at 5 ms and clamped to
reported device limits; `status()` includes that negotiated period. Noise
suppression adds 10 ms. The active DSP chain's `latency_samples()` and RVC's
`latency_ms()` are added, so AI voices or intrinsically delayed effects can exceed
30 ms. This is a scheduling/buffer estimate, not a measured round trip: Windows
hardware, VB-Cable/Discord buffering, pitch effects, and GPU inference require
measurement on the target machine.

## Decode and checks

Symphonia decodes MP3/WAV/Ogg Vorbis/FLAC, averages channels, then rubato converts
to exactly the corresponding mono 48 kHz duration. Metadata and decoded frame
counts enforce the 10-minute limit with a French error.

```sh
cargo test -p voxbox-engine
cargo clippy -p voxbox-engine --all-targets -- -D warnings
cargo fmt --manifest-path crates/voxbox-engine/Cargo.toml --check
cargo check -p voxbox-engine --target x86_64-pc-windows-msvc
```

Linux device-free tests cannot exercise WASAPI shared-mode negotiation,
VB-Cable routing, actual hot-unplug/restart, MMCSS, or end-to-end audible latency.
