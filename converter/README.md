# Offline RVC assets and conversion

The app never downloads or executes a Python installer. These scripts run on the
packaging runner, except `convert_rvc.py`, which runs with the embedded interpreter
when the user imports a local checkpoint.

## Packaging contract

1. `python converter/fetch_assets.py <resources>/rvc-assets` downloads **only** the
   checksum-pinned ContentVec and RMVPE graphs in `assets.json`. It also copies
   notices. Rust expects `contentvec.onnx` and `rmvpe.onnx` in this directory.
2. On Windows x64 with a Python 3.11 runner, execute
   `./converter/build_runtime.ps1 -OutputDir <resources>/converter`.
   `ConverterPaths` is `<resources>/converter/python.exe` plus
   `<resources>/converter/convert_rvc.py`. It contains CPU torch, FAISS and ONNX;
   pip is used on the build runner only. Preserve package `.dist-info` licences.
3. Supply native **ONNX Runtime 1.22** beside the executable, beside the shared
   assets, or via `ORT_DYLIB_PATH` (absolute path to DLL). Cargo deliberately uses
   `load-dynamic`, so a Linux cross-check needs no Windows linker or ORT download.
   The Windows build enables crate features `cuda,directml` by default.
   **Cargo features do not supply the native GPU runtime.** A single native ORT
   build with both CUDA and DirectML providers is needed to probe both in one
   process. Microsoft CUDA-only and DirectML-only distributions cannot be merged
   by copying their `onnxruntime.dll`s together. Include matching provider DLLs,
   CUDA/cuDNN prerequisites and DirectML.dll, or use a CPU-only deployment.
4. `bundled_voices.json` lists two candidates from Nekochu's VCTK-trained RVC v2
   collection. Fetch `sourceUrl` at packaging time, verify `sha256`, convert with
   `--id <id> --name <name>` into `<models>/<id>/`, then set `builtin: true` and the
   manifest's attribution/licence in `meta.json`. Preserve the model Apache-2.0
   licence and VCTK CC-BY-4.0 attribution. These are ordinary English corpus
   speakers, not celebrity or character imitations. No weights live in Git.

Example local conversion (the interpreter may be the embedded one):

```powershell
python -I converter/convert_rvc.py --pth voice.pth --index voice.index `
  --output models/my-voice --id my-voice --name 'Ma voix'
```

Only RVC **v2**, with **f0**, native **32/40/48 kHz**, 768-dimensional features and
192 latent channels is supported. Speaker zero is used for multi-speaker models.
The import controller publishes a model directory atomically after validating its
metadata; staging directories start with `.import-` and are excluded from listing.
Failures are returned with bounded stderr. `PROGRESS <0..1>` lines are monotonic;
1.0 reaches the UI only after publication. Checkpoints use `weights_only=True`;
there is no unsafe pickle retry. FAISS parsing also happens in the subprocess.

## Export provenance

`vendor/rvc/lib/infer_pack` contains the minimal inference modules from
[RVC-Project commit 7b284a6](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion/tree/7b284a634667c34103eaaeed972b48ccdb4b893e/rvc/lib/infer_pack),
MIT, with the original licence in `vendor/LICENSE`. The six-input FP32 export is
based on upstream `rvc/modules/onnx/export.py`, opset 13. Our only vendored code
modification removes `int(frame_length)` in attention padding/reshapes, which
otherwise freezes those sizes at export. Export immediately executes two different
frame lengths through CPU ORT. Tests cover all three native output rates.

Shared graphs: [TigreGotico/voiceclonnx-rvc](https://huggingface.co/TigreGotico/voiceclonnx-rvc),
pinned at `cbfbabdabe6a1414292bade8f857fb6074abf130`, with SHA-256s and original
checkpoint references recorded in `assets.json`. ContentVec is MIT; upstream RMVPE
is Apache-2.0, the community ONNX distribution additionally declares MIT. Include
both notices. ContentVec input is raw 16 kHz PCM plus an all-ones int64 attention
mask; output `[1,T,768]` is repeated at 100 Hz. RMVPE receives HTK/Slaney log-mel
(magnitude STFT, 1024 periodic Hann, hop 160, 128 bins, 30–8000 Hz), reflection
padding and zero padding to a multiple of 32. Salience `[1,T,360]` uses upstream's
local 9-bin cents average, threshold .03, then transposition and coarse mel bins.

## Index format and cost

`index.bin`: 8-byte ASCII `VOXIDX01`, u32 little-endian dimension (=768), u32
little-endian vector count (1–4096), followed by row-major little-endian float32
vectors. NaN/Inf and truncated/trailing data are rejected. RVC FAISS IndexFlat and
IndexIVFFlat are supported. At most 32768 evenly sampled source vectors are
reconstructed; CPU k-means (12 iterations, deterministic seed) reduces large
indexes to at most **1024 centroids** by default (~3 MiB). This trades retrieval
fidelity for bounded CPU work; it does not promise a universal real-time budget.
The worker blends the nearest 8 centroids with squared inverse squared-L2 weights.
No retrieval work is performed if `index_rate == 0`.

## Streaming and latency

`push`/`pop` contain only preallocated atomic SPSC overwrite queues with tagged float slots and no CAS retry loops;
there is no allocation, mutex, backoff or OS wake-up in the callback. Each queue has a single producer and a single consumer; push and pop belong to the one audio callback thread. Input/output queues
hold at most 4 seconds; full queues replace their oldest samples. A worker polls
at 1 ms, keeps 160 ms of past context, converts `block_ms + crossfade_ms` future
samples, retains the overlap and emits exactly `block_ms` samples. A raised-cosine
crossfade joins overlapping predictions. A windowed-sinc filter prevents aliasing
when converting 48→16 kHz and native model output→48 kHz. Overload discards stale
complete windows and resets overlap; audio callers fill an underrun with silence.

Timing is rounded to 10 ms: blocks 100–1000 ms, crossfade 0–block length. Invalid
floats are sanitized and pitch is clamped to ±48 semitones. Timing changes reset
the worker's scheduler. Pitch/retrieval changes apply on the next window.
`latency_ms()` conservatively adds capture window + measured inference/lock wait +
current queues + polling overhead; before the first inference, compute time is
unknown. Default minimum capture is **300 ms** (250+50), including on a GPU.
Expected GPU latency is therefore **300 ms + measured GPU inference + queues**;
no Windows GPU latency is claimed without measurement. Drop joins the worker and
must happen on a control thread. `RvcStream::start` takes an `on_error: ErrorHandler`
callback: if inference stops, it runs once, on the inference worker thread (never
the audio thread), and the stream then only yields silence. A failed stream is not
restarted: the caller replaces it with a new `RvcStream` (VoxBox does so when the
voice is selected again).

## Validation

```sh
cargo test -p voxbox-rvc
cargo clippy -p voxbox-rvc --all-targets -- -D warnings
cargo fmt -p voxbox-rvc --check
cargo check -p voxbox-rvc --target x86_64-pc-windows-msvc --features cuda,directml
python -m pytest converter/test_converter.py
```

Opt-in real checkpoint benchmark:

```sh
ORT_DYLIB_PATH=/absolute/path/libonnxruntime.so.1.22.0 \
RVC_TEST_ASSETS=/absolute/path/assets RVC_TEST_MODEL=/absolute/path/converted-voice \
cargo test --release -p voxbox-rvc real_voice_cpu_rtf -- --ignored --nocapture
```

For conversion as part of the ignored test, set `RVC_TEST_PTH` and `RVC_TEST_PYTHON` instead of `RVC_TEST_MODEL`.

This uses real ContentVec/RMVPE and a real converted RVC voice, twelve windows
emitting three seconds of synthetic harmonic input, and reports compute time per
**emitted** second (including context/overlap work). It measures throughput, not
voice naturalness, speech intelligibility or microphone-to-headphone latency.
Windows DLL loading, CUDA/DirectML execution, embedded Python native wheel loading,
GPU fallback and subjective speech quality still require a Windows machine.

Observed sandbox results and remaining Windows checks are in [VALIDATION.md](VALIDATION.md).
