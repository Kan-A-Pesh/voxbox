# Validation in the Linux CPU sandbox (2026-11-05)

- `cargo test -p voxbox-rvc`: **14 passed**, one opt-in model test ignored by
  default. Includes resampling/DC/anti-aliasing, raised-cosine continuity,
  scheduling/reconfiguration, index parsing/k-NN, metadata/listing, progress,
  overwrite ordering with concurrent producer/consumer, preempted producer,
  deliberately stalled inference and **zero allocations in audio callbacks**.
- `cargo clippy -p voxbox-rvc --all-targets -- -D warnings`: **passed**.
- `cargo fmt -p voxbox-rvc --check`: **passed**.
- `cargo check -p voxbox-rvc --target x86_64-pc-windows-msvc --features cuda,directml`:
  **passed**, including Windows DXGI device naming and both provider APIs.
  Dynamic ORT loading avoids a native cross-link/download requirement.
- Python 3.11, dependencies from `requirements.txt`:
  `python -m pytest converter/test_converter.py -q`: **10 passed**. Three tests
  construct small real RVC architectures at 32/40/48 kHz, export through torch,
  then execute two distinct dynamic lengths through CPU ONNX Runtime. Exporter
  emits upstream tracing/constant-folding warnings; execution succeeds. The
  pickle-execution regression test confirms an executable checkpoint is refused.
- `python converter/fetch_assets.py /tmp/voxbox-rvc-assets`: **passed**, both
  downloaded files match manifest SHA-256s. Notices are copied with the assets.

## Real checkpoint conversion and throughput

Downloaded Nekochu's VCTK p231 RMVPE checkpoint, SHA-256
`12f819e129c6e48779439e491b85593b8819d094f751c3515ea13be6bd8b5a59`,
from the pinned revision in `bundled_voices.json`. Invoked the opt-in Rust test
with `RVC_TEST_PTH` and `RVC_TEST_PYTHON`, so it actually exercised `import_model`,
the converter subprocess, monotonic progress, atomic publication, model listing,
ContentVec, RMVPE and the exported synthesizer. The importer used the pinned Python
requirements. All outputs had the expected lengths, finite values and nonzero
energy. No weights were added to the repository.

Command (paths refer to sandbox-only downloads):

```sh
RVC_TEST_ASSETS=/tmp/voxbox-rvc-assets \
RVC_TEST_PTH=/tmp/voxbox-rvc-assets/Fp231rmvpe.pth \
RVC_TEST_PYTHON=/tmp/voxbox-rvc-py311/bin/python \
ORT_DYLIB_PATH=/tmp/voxbox-rvc-py311/lib/python3.11/site-packages/onnxruntime/capi/libonnxruntime.so.1.22.0 \
cargo test --release -p voxbox-rvc real_voice_cpu_rtf -- --ignored --nocapture
```

AMD EPYC 7402, shared Linux host, ORT CPU intra-op threads=2, release profile:
**39.521 seconds compute / 3.000 seconds emitted = RTF 13.174**, mean
**3293.4 ms** per emitted 250 ms block. Twelve windows include 160 ms retained
context and 50 ms overlap; input is a synthetic 220/440 Hz harmonic signal,
retrieval is absent. Model loading and conversion are excluded from the RTF.
An earlier release run with the already-converted model measured RTF **8.655**;
other jobs shared the machine, so these are observed sandbox numbers, not a
stable hardware performance claim. CPU fallback is functional but **does not
sustain real-time conversion here**.

Default capture alone costs **300 ms** (250 ms block + 50 ms overlap). Expected
GPU latency is 300 ms plus actual GPU inference, worker polling and queued audio;
there is no measured GPU number. Windows native DLL loading, CUDA/DirectML
execution/fallback, embedded Python wheel loading and subjective speech quality
remain unverified. Packaging must provide an ORT 1.22 native library with the
execution providers it wishes to offer; enabling Cargo features supplies no DLLs.
