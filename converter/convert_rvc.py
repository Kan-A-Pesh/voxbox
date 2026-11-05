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

VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR))


def progress(value: float) -> None:
    print(f"PROGRESS {value:.2f}", flush=True)


def validate_checkpoint(checkpoint: dict) -> tuple[list, dict, int]:
    if not isinstance(checkpoint, dict) or checkpoint.get("version") != "v2" or checkpoint.get("f0") != 1:
        raise ValueError("Seuls les modèles RVC v2 avec f0 sont pris en charge.")
    config = list(checkpoint["config"])
    weights = checkpoint["weight"]
    if len(config) != 18 or not isinstance(weights, dict):
        raise ValueError("Configuration RVC incorrecte.")
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
    return config, weights, sample_rate


def export_model(pth: Path, output: Path) -> int:
    import torch
    import onnx
    from rvc.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM

    torch.set_num_threads(2)
    checkpoint = torch.load(pth, map_location="cpu", weights_only=True)
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


def convert(pth: Path, index: Path | None, output: Path, model_id: str, name: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", model_id) or not name.strip():
        raise ValueError("Identifiant ou nom invalide.")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("Le dossier de sortie doit être vide.")
    progress(0.0)
    sample_rate = export_model(pth, output / "model.onnx")
    progress(0.75)
    if index is not None:
        convert_index(index, output / "index.bin")
    progress(0.95)
    meta = {"id": model_id, "name": name.strip(), "modelSampleRate": sample_rate,
            "hasIndex": index is not None, "builtin": False, "license": None}
    (output / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress(1.0)
    return meta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pth", required=True, type=Path)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    try:
        convert(args.pth, args.index, args.output, args.id, args.name)
    except Exception as error:
        print(f"Échec de conversion : {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
