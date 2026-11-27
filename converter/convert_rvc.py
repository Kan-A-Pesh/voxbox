#!/usr/bin/env python3
"""Offline RVC v2/f0 export, using the MIT RVC-Project ONNX implementation.

Upstream export: https://github.com/RVC-Project/Retrieval-based-Voice-Conversion/
blob/7b284a634667c34103eaaeed972b48ccdb4b893e/rvc/modules/onnx/export.py
Only the required inference modules are vendored, with their original MIT licence.
Checkpoints are untrusted: weights_only=True is mandatory; never retry with pickle.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import struct
import sys
import zipfile

# Read by the app (voxbox_rvc::converter_api) before importing a downloaded model: 2 = architecture
# bounds checked before the synthesizer is built, 3 = `--untrusted` (directory and metadata sizes
# bounded before they are read, tensors memory-mapped, PyTorch >= 2.10, OS memory ceiling). Bump it with every hardening the app relies on.
CONVERTER_API = 3

# Pickled metadata of an untrusted checkpoint (config, tensor keys and shapes): published RVC v2
# models carry well under 1 MB. PyTorch reads and unpickles it whole before anything is checked.
MAX_METADATA_BYTES = 8 * 1024 * 1024
# Tensors of an untrusted checkpoint (a few hundred in RVC v2), each one a record of the zip.
MAX_RECORDS = 10_000

VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR))


def progress(value: float) -> None:
    print(f"PROGRESS {value:.2f}", flush=True)


def _ints(values, low: int, high: int) -> bool:
    return isinstance(values, (list, tuple)) and all(
        isinstance(v, int) and not isinstance(v, bool) and low <= v <= high for v in values
    )


# Combined budget for the synthesizer built from a checkpoint's configuration, in parameters
# (float32: 4 bytes each). Published RVC v2 models need about 35 M; this allows 600 MB.
MAX_PARAMETERS = 150_000_000


def estimated_parameters(config: list) -> int:
    """Upper estimate of the synthesizer's parameters (rvc/lib/infer_pack/models_onnx.py).

    Counts every convolution and embedding the constructor allocates from the configuration:
    text encoder (attention + feed-forward per layer), NSF decoder (upsampling + 6-conv
    resblocks per stage), posterior encoder (16-layer WaveNet), flow (4 x 3-layer WaveNet) and
    speaker embedding.
    """
    (spec, _segment, inter, hidden, filters, _heads, layers, kernel, _dropout, _resblock,
     rb_kernels, _rb_dilations, _rates, up_initial, up_kernels, speakers, gin, _rate) = config
    total = 768 * hidden + layers * (4 * hidden * hidden + 2 * hidden * filters * kernel)
    total += hidden * 2 * inter + inter * up_initial * 7 + gin * up_initial
    channels = up_initial
    for up_kernel in up_kernels:
        total += channels * (channels // 2) * up_kernel
        channels //= 2
        total += sum(6 * channels * channels * k for k in rb_kernels)

    def wavenet(wn_layers: int) -> int:
        return wn_layers * (hidden * 2 * hidden * 5 + hidden * 2 * hidden + gin * 2 * hidden)

    total += spec * hidden + wavenet(16) + hidden * 2 * inter
    total += 4 * (inter * hidden + wavenet(3))
    return total + speakers * gin


def validate_architecture(config: list) -> None:
    """Bounds the checkpoint's configuration before the synthesizer is built from it.

    Each dimension sits within reach of the published RVC v2 configurations (32/40/48 kHz) and
    their combination is capped by MAX_PARAMETERS: a crafted checkpoint (e.g. downloaded from
    voice-models.com) cannot make the constructor allocate gigabytes before its weights are
    checked.
    """
    (spec, segment, _inter, hidden, filters, heads, layers, kernel, dropout, resblock,
     rb_kernels, rb_dilations, rates, up_initial, up_kernels, _speakers, gin, _rate) = config
    ok = (
        _ints([spec], 1, 1025) and _ints([segment], 1, 1024) and _ints([hidden], 1, 256)
        and _ints([filters], 1, 1024) and _ints([heads], 1, 8) and hidden % heads == 0
        and _ints([layers], 1, 8) and _ints([kernel], 1, 7)
        and isinstance(dropout, (int, float)) and not isinstance(dropout, bool) and 0 <= dropout < 1
        and resblock in ("1", "2")
        and _ints(rb_kernels, 1, 11) and 1 <= len(rb_kernels) <= 3
        and isinstance(rb_dilations, (list, tuple)) and len(rb_dilations) == len(rb_kernels)
        # ResBlock1 reads three dilations per kernel, ResBlock2 two (vendor infer_pack/modules.py).
        and all(_ints(d, 1, 11) and (3 <= len(d) <= 4 if resblock == "1" else len(d) == 2)
                for d in rb_dilations)
        and _ints(rates, 1, 16) and 1 <= len(rates) <= 5
        and _ints(up_kernels, 1, 32) and len(up_kernels) == len(rates)
        and _ints([up_initial], 1, 512) and _ints([gin], 1, 256)
    )
    if not ok:
        raise ValueError("Architecture RVC hors des limites prises en charge.")


def validate_checkpoint(checkpoint: dict) -> tuple[list, dict, int]:
    if not isinstance(checkpoint, dict) or checkpoint.get("version") != "v2" or checkpoint.get("f0") != 1:
        raise ValueError("Seuls les modèles RVC v2 avec f0 sont pris en charge.")
    config = list(checkpoint["config"])
    weights = checkpoint["weight"]
    if len(config) != 18 or not isinstance(weights, dict):
        raise ValueError("Configuration RVC incorrecte.")
    validate_architecture(config)
    sample_rate = config[-1]
    if sample_rate not in (32000, 40000, 48000):
        raise ValueError("Fréquence attendue : 32, 40 ou 48 kHz.")
    if config[2] != 192 or weights["enc_p.emb_phone.weight"].shape[1] != 768:
        raise ValueError("Dimensions RVC v2 non prises en charge.")
    if math.prod(config[12]) * 100 != sample_rate:
        raise ValueError("Cadence du synthétiseur incohérente avec la fréquence déclarée.")
    config[-3] = weights["emb_g.weight"].shape[0]
    if config[-3] < 1:
        raise ValueError("Aucun locuteur dans le modèle.")
    if config[-3] > 4096 or estimated_parameters(config) > MAX_PARAMETERS:
        raise ValueError("Architecture RVC hors des limites prises en charge.")
    return config, weights, sample_rate


# Central directory of an untrusted checkpoint, read whole by zipfile and by PyTorch's reader.
MAX_DIRECTORY_BYTES = MAX_RECORDS * 512
# First PyTorch release whose weights_only loader is not affected by GHSA-63cw-57p8-fm3p.
MIN_UNTRUSTED_TORCH = (2, 10)
_EOCD = struct.Struct("<4s4H2LH")
_ZIP64_LOCATOR = struct.Struct("<4sLQL")
_ZIP64_EOCD = struct.Struct("<4sQ2H2L4Q")


def _directory_size(pth: Path) -> tuple[int, int]:
    """(entries, central directory bytes) from the end records alone, before any parser
    materializes the directory.

    Only the one layout torch.save (and zipfile) writes is accepted, so every reader (zipfile,
    PyTorch's miniz) finds the same directory: the end record last with no comment, optionally
    preceded by a zip64 locator and the zip64 end record it points to, themselves right after the
    central directory. Any other arrangement (a comment, a stray locator, records that disagree)
    is refused instead of being interpreted.
    """
    refused = ValueError("Fichier de modèle hors des limites prises en charge.")
    size = pth.stat().st_size
    if size < _EOCD.size:
        raise refused
    with open(pth, "rb") as f:
        end = size - _EOCD.size
        f.seek(end)
        signature, disk, disk_cd, entries_disk, entries, directory, offset, comment = _EOCD.unpack(f.read(_EOCD.size))
        if signature != b"PK\x05\x06" or comment != 0 or disk != 0 or disk_cd != 0 or entries_disk != entries:
            raise refused
        records_start = end
        locator = end - _ZIP64_LOCATOR.size
        if locator >= 0:
            f.seek(locator)
            signature, z64_disk, z64_offset, disks = _ZIP64_LOCATOR.unpack(f.read(_ZIP64_LOCATOR.size))
            if signature == b"PK\x06\x07":
                record = locator - _ZIP64_EOCD.size
                if z64_disk != 0 or disks != 1 or record < 0 or z64_offset != record:
                    raise refused
                f.seek(record)
                fields = _ZIP64_EOCD.unpack(f.read(_ZIP64_EOCD.size))
                # Size of the remaining record: 44 means no extensible data after it.
                if fields[0] != b"PK\x06\x06" or fields[1] != _ZIP64_EOCD.size - 12 or fields[4] or fields[5] \
                        or fields[6] != fields[7]:
                    raise refused
                for classic, wide, saturated in ((entries, fields[7], 0xFFFF), (directory, fields[8], 0xFFFFFFFF),
                                                 (offset, fields[9], 0xFFFFFFFF)):
                    if classic != saturated and classic != wide:
                        raise refused
                entries, directory, offset = fields[7], fields[8], fields[9]
                records_start = record
            elif 0xFFFF in (entries,) or 0xFFFFFFFF in (directory, offset):
                raise refused
    # The directory ends exactly where the end records begin.
    if offset + directory != records_start:
        raise refused
    return entries, directory


def check_untrusted_checkpoint(pth: Path) -> None:
    """Bounds what is read into memory for a downloaded checkpoint before torch.load runs.

    Only the zip format (written by every torch >= 1.6) is accepted. Its directory is bounded
    from the end records before it is parsed; then every record PyTorch reads whole (data.pkl,
    version, byteorder, serialization id: everything but the tensors under data/) is bounded
    together. The tensors are memory-mapped by the caller, so bounded by the file on disk,
    itself capped by the download.
    """
    if not zipfile.is_zipfile(pth):
        raise ValueError("Format de modèle trop ancien pour un import en ligne.")
    entries, directory = _directory_size(pth)
    if entries > MAX_RECORDS or directory > MAX_DIRECTORY_BYTES:
        raise ValueError("Fichier de modèle hors des limites prises en charge.")
    with zipfile.ZipFile(pth) as archive:
        records = archive.infolist()
    metadata = [r for r in records if r.filename == "data.pkl" or r.filename.endswith("/data.pkl")]
    read_whole = sum(r.file_size for r in records if not re.search(r"(^|/)data/\d+$", r.filename))
    if len(metadata) != 1 or len(records) > MAX_RECORDS or read_whole > MAX_METADATA_BYTES:
        raise ValueError("Fichier de modèle hors des limites prises en charge.")


# Memory an untrusted conversion may commit, from torch.load to the ONNX export (a published
# 40 kHz model peaks near 1 GB). Enforced by the OS: PyTorch's loader allocates from
# checkpoint-controlled metadata before the checkpoint can be validated.
MAX_UNTRUSTED_MEMORY = 4 * 1024**3
_JOB_HANDLES = []


def limit_memory(budget: int, mapped: int) -> None:
    """Caps this process's memory for the rest of its life, or raises (never runs unbounded).

    Windows: a job object with a per-process commit limit (file-backed mappings are not
    commit, so `mapped` is not added). Elsewhere: RLIMIT_AS, which counts the memory-mapped
    checkpoint (`mapped` bytes) too. Past the limit, allocations fail: torch.load raises, the
    converter exits non-zero and the app removes its staging folder.
    """
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", ctypes.c_uint64 * 6),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit = budget
        # 9 = JobObjectExtendedLimitInformation. Nested jobs (Windows 8+) keep any outer limit.
        if not job or not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) \
                or not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
            raise ValueError(f"Limite mémoire impossible à appliquer (erreur {ctypes.get_last_error()}).")
        _JOB_HANDLES.append(job)  # Closed with the process: the limit lasts until it exits.
        return
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    limit = budget + mapped
    if hard != resource.RLIM_INFINITY:
        limit = min(limit, hard)
    if soft == resource.RLIM_INFINITY or soft > limit:
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))


def _torch_release(version: str) -> tuple[int, int]:
    match = re.match(r"(\d+)\.(\d+)", version)
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


def export_model(pth: Path, output: Path, untrusted: bool = False) -> int:
    import torch
    import onnx
    from rvc.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM

    torch.set_num_threads(2)
    if untrusted:
        if _torch_release(torch.__version__) < MIN_UNTRUSTED_TORCH:
            raise ValueError("PyTorch trop ancien pour un modèle téléchargé : mets à jour le pack « VoxBox - Voix IA ».")
        check_untrusted_checkpoint(pth)
        limit_memory(MAX_UNTRUSTED_MEMORY, pth.stat().st_size)
    # Memory-mapped when the format allows it (zip): the tensors stay in the file until the
    # checkpoint is validated. A local legacy-format file is still read the classic way.
    mmap = zipfile.is_zipfile(pth)
    checkpoint = torch.load(pth, map_location="cpu", weights_only=True, mmap=mmap)
    config, weights, sample_rate = validate_checkpoint(checkpoint)
    net = SynthesizerTrnMsNSFsidM(*config, is_half=False, version="v2").float().eval()
    incompatible = net.load_state_dict(weights, strict=False)
    missing = [key for key in incompatible.missing_keys if not key.startswith("enc_q.")]
    if missing or incompatible.unexpected_keys:
        raise ValueError(f"Poids incompatibles : absents={missing}, inattendus={incompatible.unexpected_keys}")
    progress(0.20)
    # Same six inputs, 768 channels and opset 13 as RVC-Project export.py.
    frames = 50
    with torch.inference_mode():
        torch.onnx.export(
            net,
            (torch.randn(1, frames, 768), torch.tensor([frames], dtype=torch.long),
             torch.full((1, frames), 100, dtype=torch.long), torch.full((1, frames), 220.0),
             torch.tensor([0], dtype=torch.long), torch.randn(1, 192, frames)),
            str(output), input_names=["phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd"],
            output_names=["audio"], dynamic_axes={"phone": {1: "frames"}, "pitch": {1: "frames"},
                "pitchf": {1: "frames"}, "rnd": {2: "frames"}, "audio": {2: "samples"}},
            do_constant_folding=False, opset_version=13, dynamo=False,
        )
    onnx.checker.check_model(str(output))
    # Upstream's exporter once baked int(frame_count) into relative attention.
    # Validate two different streaming lengths so a bad export never enters models/.
    import numpy as np
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(output), options, providers=["CPUExecutionProvider"])
    for length in (26, 61):
        audio = session.run(None, {
            "phone": np.zeros((1,length,768), np.float32),
            "phone_lengths": np.array([length], np.int64),
            "pitch": np.full((1,length), 100, np.int64),
            "pitchf": np.full((1,length), 220, np.float32),
            "ds": np.array([0], np.int64), "rnd": np.zeros((1,192,length),np.float32),
        })[0]
        if audio.shape != (1,1,length * sample_rate // 100) or not np.isfinite(audio).all():
            raise ValueError("Sortie ONNX invalide pour une longueur dynamique.")
    return sample_rate


def write_index(vectors, destination: Path) -> None:
    import numpy as np
    vectors = np.asarray(vectors, dtype="<f4", order="C")
    if vectors.ndim != 2 or vectors.shape[1] != 768 or not 1 <= len(vectors) <= 4096:
        raise ValueError("Index attendu : 1..4096 vecteurs de dimension 768.")
    if not np.isfinite(vectors).all():
        raise ValueError("Index contenant des valeurs non finies.")
    with destination.open("wb") as stream:
        stream.write(struct.pack("<8sII", b"VOXIDX01", 768, len(vectors)))
        stream.write(vectors.tobytes())


def convert_index(source: Path, destination: Path, max_centroids: int = 1024) -> None:
    import faiss
    import numpy as np
    faiss.omp_set_num_threads(2)
    index = faiss.read_index(str(source))
    if index.d != 768 or index.ntotal < 1 or not 1 <= max_centroids <= 4096:
        raise ValueError("Index FAISS vide ou incompatible avec RVC v2.")
    # IVF-Flat is RVC's standard format. Build a direct map so reconstruct(id)
    # works. Refuse compressed/ID-mapped/custom indexes instead of inventing data.
    if isinstance(index, faiss.IndexIVFFlat):
        index.make_direct_map()
    elif not isinstance(index, faiss.IndexFlat):
        raise ValueError("Formats pris en charge : FAISS IndexFlat / IndexIVFFlat.")
    # Reconstruct at most 32768 evenly sampled vectors: bounded memory and work.
    count = min(index.ntotal, 32768)
    ids = np.linspace(0, index.ntotal - 1, count, dtype=np.int64)
    vectors = np.stack([index.reconstruct(int(i)) for i in ids]).astype(np.float32)
    if not np.isfinite(vectors).all():
        raise ValueError("Index contenant des valeurs non finies.")
    clusters = min(max_centroids, max(1, count // 16)) if count > max_centroids else count
    if count > max_centroids:
        kmeans = faiss.Kmeans(768, clusters, niter=12, nredo=1, seed=42, gpu=False)
        kmeans.train(vectors)
        vectors = kmeans.centroids
    write_index(vectors, destination)


def convert_index_isolated(source: Path, destination: Path) -> None:
    """Runs convert_index in its own interpreter.

    faiss (libomp140) and PyTorch (libiomp5md) each bring their own OpenMP
    runtime; loading both in one process aborts with "OMP: Error #15". The
    index never shares a process with torch, so neither runtime is masked.
    """
    import subprocess
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()),
         "--index-only", "--index", str(source), "--output", str(destination)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or f"code {result.returncode}"
        raise ValueError(f"Conversion de l'index impossible : {detail}")


def convert(pth: Path, index: Path | None, output: Path, model_id: str, name: str,
            untrusted: bool = False) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", model_id) or not name.strip():
        raise ValueError("Identifiant ou nom invalide.")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("Le dossier de sortie doit être vide.")
    progress(0.0)
    sample_rate = export_model(pth, output / "model.onnx", untrusted)
    progress(0.75)
    if index is not None:
        convert_index_isolated(index, output / "index.bin")
    progress(0.95)
    meta = {"id": model_id, "name": name.strip(), "modelSampleRate": sample_rate,
            "hasIndex": index is not None, "builtin": False, "license": None}
    (output / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress(1.0)
    return meta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pth", type=Path)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--id")
    parser.add_argument("--name")
    # Set by the app for a downloaded checkpoint (voxbox_rvc::import_online_model).
    parser.add_argument("--untrusted", action="store_true")
    # Internal: converts only --index into the --output file (see convert_index_isolated).
    parser.add_argument("--index-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.index_only:
        if args.index is None:
            parser.error("--index-only requiert --index")
    elif args.pth is None or args.id is None or args.name is None:
        parser.error("--pth, --id et --name sont requis")
    try:
        if args.index_only:
            convert_index(args.index, args.output)
        else:
            if args.untrusted and args.index is not None:
                parser.error("--untrusted n'accepte pas --index")
            convert(args.pth, args.index, args.output, args.id, args.name, args.untrusted)
    except Exception as error:
        print(f"Échec de conversion : {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
