import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np
import pytest

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import convert_rvc as converter
import fetch_assets


def test_index_header_and_invalid_vectors(tmp_path):
    path = tmp_path / "index.bin"
    values = np.arange(1536, dtype=np.float32).reshape(2, 768)
    converter.write_index(values, path)
    raw = path.read_bytes()
    assert struct.unpack("<8sII", raw[:16]) == (b"VOXIDX01", 768, 2)
    np.testing.assert_array_equal(np.frombuffer(raw[16:], dtype="<f4").reshape(2,768), values)
    for values in [np.zeros((0,768)), np.zeros((1,256)), np.full((1,768), np.nan)]:
        with pytest.raises(ValueError): converter.write_index(values, path)


def test_faiss_flat_and_ivf(tmp_path):
    import faiss
    vectors = np.random.default_rng(42).normal(size=(300,768)).astype(np.float32)
    for index in [faiss.IndexFlatL2(768), faiss.IndexIVFFlat(faiss.IndexFlatL2(768),768,2)]:
        if not index.is_trained: index.train(vectors)
        index.add(vectors)
        source = tmp_path / "voice.index"
        faiss.write_index(index, str(source))
        converter.convert_index(source, tmp_path / "index.bin", max_centroids=8)
        raw = (tmp_path / "index.bin").read_bytes()
        magic, dim, count = struct.unpack("<8sII", raw[:16])
        assert magic == b"VOXIDX01" and dim == 768 and count <= 8
        assert len(raw) == 16 + count * 768 * 4
        assert np.isfinite(np.frombuffer(raw[16:], dtype="<f4")).all()


def test_rejects_wrong_checkpoint():
    for checkpoint in [{}, {"version":"v1","f0":1}, {"version":"v2","f0":0}]:
        with pytest.raises(ValueError): converter.validate_checkpoint(checkpoint)


def test_metadata_and_progress(monkeypatch, tmp_path, capsys):
    def fake_export(source, dest): dest.write_bytes(b"onnx"); return 48000
    monkeypatch.setattr(converter,"export_model",fake_export)
    meta = converter.convert(Path("in.pth"),None,tmp_path / "voice","test"," Essai ")
    assert json.loads((tmp_path / "voice/meta.json").read_text()) == meta
    assert meta == {"id":"test","name":"Essai","modelSampleRate":48000,"hasIndex":False,"builtin":False,"license":None}
    values = [float(line.split()[1]) for line in capsys.readouterr().out.splitlines()]
    assert values == sorted(values) and values[0] == 0.0 and values[-1] == 1.0
    with pytest.raises(ValueError): converter.convert(Path("in.pth"),None,tmp_path / "voice","test","Essai")
    with pytest.raises(ValueError): converter.convert(Path("in.pth"),None,tmp_path / "x","../escape","Essai")


def test_fetch_checksum_and_cache(tmp_path):
    source = tmp_path / "source"; source.write_bytes(b"packaging asset")
    asset = {"filename":"model.onnx","url":source.as_uri(),"sha256":hashlib.sha256(source.read_bytes()).hexdigest()}
    out = fetch_assets.fetch_asset(asset,tmp_path / "assets")
    assert out.read_bytes() == source.read_bytes()
    source.unlink()
    assert fetch_assets.fetch_asset(asset,tmp_path / "assets") == out  # cached, no network
    source.write_bytes(b"corrupt")
    asset["sha256"] = "0"*64
    with pytest.raises(ValueError, match="SHA256"): fetch_assets.fetch_asset(asset,tmp_path / "bad")
    assert not (tmp_path / "bad/model.onnx").exists()
    assert not (tmp_path / "bad/model.onnx.part").exists()


def test_packaging_manifests_are_pinned():
    manifest = json.loads((ROOT / "assets.json").read_text())
    voices = json.loads((ROOT / "bundled_voices.json").read_text())
    for asset in manifest["assets"] + voices:
        assert len(asset["sha256"]) == 64
        assert asset["license"]
        url = asset.get("url",asset.get("sourceUrl"))
        assert "/resolve/main/" not in url


@pytest.mark.parametrize("rate,upsample", [(32000,[10,8,2,2]),(40000,[10,10,2,2]),(48000,[10,12,2,2])])
def test_real_export_dynamic_lengths_all_rates(tmp_path, rate, upsample):
    """Small synthetic architecture, real torch export and ORT executions at 26/61 frames."""
    import torch
    from rvc.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM
    torch.set_num_threads(2)
    config = [1025,32,192,32,64,2,1,3,0.0,"1",[3],[[1,3,5]],upsample,128,
              [2*s for s in upsample],1,16,rate]
    model = SynthesizerTrnMsNSFsidM(*config,is_half=False,version="v2").eval()
    checkpoint = {"config":config,"weight":model.state_dict(),"version":"v2","f0":1}
    source = tmp_path / "synthetic.pth"
    torch.save(checkpoint,source)
    assert converter.export_model(source,tmp_path / "model.onnx") == rate


def test_checkpoint_never_executes_pickle(tmp_path):
    import os
    import torch
    marker = tmp_path / "executed"
    class Malicious:
        def __reduce__(self):
            return os.system, (f'echo unsafe > "{marker}"',)
    source = tmp_path / "bad.pth"
    torch.save(Malicious(), source)
    with pytest.raises(Exception, match="[Ww]eights|Unsupported|blocked"):
        converter.export_model(source, tmp_path / "bad.onnx")
    assert not marker.exists()
