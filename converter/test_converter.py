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


@pytest.fixture(autouse=True)
def memory_limits(monkeypatch):
    """Records the memory ceilings an untrusted conversion asks for, without capping pytest
    itself (see test_the_memory_ceiling_fails_the_conversion for the real one)."""
    calls = []
    monkeypatch.setattr(converter, "limit_memory", lambda budget, mapped: calls.append((budget, mapped)))
    return calls


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


def test_index_runs_in_its_own_process(tmp_path, monkeypatch):
    """faiss and torch each load their own OpenMP: they must never share a process."""
    import faiss
    vectors = np.random.default_rng(7).normal(size=(64,768)).astype(np.float32)
    index = faiss.IndexFlatL2(768)
    index.add(vectors)
    source = tmp_path / "voice.index"
    faiss.write_index(index, str(source))
    calls = []
    monkeypatch.setattr(converter, "convert_index", lambda *a, **k: calls.append(a))
    converter.convert_index_isolated(source, tmp_path / "index.bin")
    assert calls == [], "the index is converted by a child interpreter, not in this one"
    raw = (tmp_path / "index.bin").read_bytes()
    assert struct.unpack("<8sII", raw[:16])[:2] == (b"VOXIDX01", 768)
    (tmp_path / "broken.index").write_bytes(b"not faiss")
    with pytest.raises(ValueError, match="Conversion de l'index impossible"):
        converter.convert_index_isolated(tmp_path / "broken.index", tmp_path / "x.bin")


def test_rejects_wrong_checkpoint():
    for checkpoint in [{}, {"version":"v1","f0":1}, {"version":"v2","f0":0}]:
        with pytest.raises(ValueError): converter.validate_checkpoint(checkpoint)


class _Shape:
    def __init__(self, *shape): self.shape = shape


def _checkpoint(config):
    weights = {"enc_p.emb_phone.weight": _Shape(192, 768), "emb_g.weight": _Shape(1, 256)}
    return {"version": "v2", "f0": 1, "config": config, "weight": weights}


# RVC v2 as published by RVC-Project (configs/v2/{32,40,48}k.json).
STANDARD_40K = [1025, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
                [10, 10, 2, 2], 512, [16, 16, 4, 4], 109, 256, 40000]
STANDARD_48K = [1025, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
                [12, 10, 2, 2], 512, [24, 20, 4, 4], 109, 256, 48000]
STANDARD_32K = [513, 32, 192, 192, 768, 2, 6, 3, 0, "1", [3, 7, 11], [[1, 3, 5]] * 3,
                [10, 8, 2, 2], 512, [20, 16, 4, 4], 109, 256, 32000]


def test_declares_its_api_level_on_one_line_for_the_app():
    # voxbox_rvc::converter_api reads this exact line from the installed script.
    assert "\nCONVERTER_API = 3\n" in (ROOT / "convert_rvc.py").read_text(encoding="utf-8")
    assert converter.CONVERTER_API == 3


def test_accepts_published_architectures_and_bounds_crafted_ones():
    for standard in (STANDARD_32K, STANDARD_40K, STANDARD_48K):
        config, _, rate = converter.validate_checkpoint(_checkpoint(list(standard)))
        assert rate == standard[-1] and config[-3] == 1
    for position, value in [(4, 10**9), (6, 10**6), (13, 10**7), (10, [3] * 100), (11, "x"), (14, [16, 16, 4]),
                            (5, 0), (3, 191), (16, True)]:
        crafted = list(STANDARD_40K)
        crafted[position] = value
        with pytest.raises(ValueError, match="limites"):
            converter.validate_checkpoint(_checkpoint(crafted))
    # ResBlock2 takes two dilations per kernel (three or four are ResBlock1's shape).
    resblock2 = list(STANDARD_40K)
    resblock2[9], resblock2[11] = "2", [[1, 3]] * 3
    assert converter.validate_checkpoint(_checkpoint(resblock2))[2] == 40000
    for dilations in ([[1, 3, 5]] * 3, [[1]] * 3):
        crafted = list(resblock2)
        crafted[11] = dilations
        with pytest.raises(ValueError, match="limites"):
            converter.validate_checkpoint(_checkpoint(crafted))
    crafted = list(STANDARD_40K)
    crafted[11] = [[1, 3]] * 3
    with pytest.raises(ValueError, match="limites"):
        converter.validate_checkpoint(_checkpoint(crafted))
    # Every field at its own limit: the combination still has to fit MAX_PARAMETERS.
    widest = [1025, 1024, 192, 256, 1024, 8, 8, 7, 0, "1", [11, 11, 11], [[11, 11, 11]] * 3,
              [16, 16, 16, 16, 16], 512, [32] * 5, 1, 256, 0]
    assert converter.estimated_parameters(widest) <= converter.MAX_PARAMETERS
    assert converter.estimated_parameters(STANDARD_40K) < 50_000_000
    # The reviewer's combination (feed-forward alone ~1.9 GiB at the former limits) is refused.
    for position, value in [(3, 512), (4, 2048), (6, 16), (7, 15)]:
        crafted = list(STANDARD_40K)
        crafted[position] = value
        with pytest.raises(ValueError, match="limites"):
            converter.validate_checkpoint(_checkpoint(crafted))
    many_speakers = _checkpoint(list(STANDARD_40K))
    many_speakers["weight"]["emb_g.weight"] = _Shape(10**6, 256)
    with pytest.raises(ValueError, match="limites"):
        converter.validate_checkpoint(many_speakers)


def test_metadata_and_progress(monkeypatch, tmp_path, capsys):
    seen = []
    def fake_export(source, dest, untrusted): seen.append(untrusted); dest.write_bytes(b"onnx"); return 48000
    monkeypatch.setattr(converter,"export_model",fake_export)
    meta = converter.convert(Path("in.pth"),None,tmp_path / "voice","test"," Essai ")
    assert json.loads((tmp_path / "voice/meta.json").read_text()) == meta
    assert meta == {"id":"test","name":"Essai","modelSampleRate":48000,"hasIndex":False,"builtin":False,"license":None}
    values = [float(line.split()[1]) for line in capsys.readouterr().out.splitlines()]
    assert values == sorted(values) and values[0] == 0.0 and values[-1] == 1.0
    with pytest.raises(ValueError): converter.convert(Path("in.pth"),None,tmp_path / "voice","test","Essai")
    converter.convert(Path("in.pth"),None,tmp_path / "online","test","Essai",untrusted=True)
    assert seen == [False, True]
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


@pytest.mark.parametrize("rate,upsample,resblock,dilations", [
    (32000,[10,8,2,2],"1",[[1,3,5]]), (40000,[10,10,2,2],"1",[[1,3,5]]), (48000,[10,12,2,2],"1",[[1,3,5]]),
    (40000,[10,10,2,2],"2",[[1,3]]),
])
def test_real_export_dynamic_lengths_all_rates(tmp_path, rate, upsample, resblock, dilations, memory_limits):
    """Small synthetic architecture, real torch export and ORT executions at 26/61 frames."""
    import torch
    from rvc.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM
    torch.set_num_threads(2)
    config = [1025,32,192,32,64,2,1,3,0.0,resblock,[3],dilations,upsample,128,
              [2*s for s in upsample],1,16,rate]
    model = SynthesizerTrnMsNSFsidM(*config,is_half=False,version="v2").eval()
    checkpoint = {"config":config,"weight":model.state_dict(),"version":"v2","f0":1}
    source = tmp_path / "synthetic.pth"
    torch.save(checkpoint,source)
    # A real checkpoint passes the online import bounds, under the memory ceiling.
    assert converter.export_model(source,tmp_path / "model.onnx",untrusted=True) == rate
    assert memory_limits == [(converter.MAX_UNTRUSTED_MEMORY, source.stat().st_size)]


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


def test_untrusted_checkpoints_are_bounded_before_torch_reads_them(tmp_path, monkeypatch):
    import torch
    import zipfile
    calls = []
    monkeypatch.setattr(torch, "load", lambda *a, **k: calls.append(k) or (_ for _ in ()).throw(RuntimeError("loaded")))
    legacy = tmp_path / "legacy.pth"
    legacy.write_bytes(b"\x80\x02not a zip")
    with pytest.raises(ValueError, match="trop ancien"):
        converter.export_model(legacy, tmp_path / "a.onnx", untrusted=True)
    huge = tmp_path / "huge.pth"
    with zipfile.ZipFile(huge, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("model/data.pkl", b"\0" * (converter.MAX_METADATA_BYTES + 1))
    many = tmp_path / "many.pth"
    with zipfile.ZipFile(many, "w") as archive:
        archive.writestr("model/data.pkl", b"x")
        for i in range(converter.MAX_RECORDS):
            archive.writestr(f"model/data/{i}", b"")
    no_metadata = tmp_path / "none.pth"
    with zipfile.ZipFile(no_metadata, "w") as archive:
        archive.writestr("model/data/0", b"")
    for crafted in (huge, many, no_metadata):
        with pytest.raises(ValueError, match="limites"):
            converter.export_model(crafted, tmp_path / "b.onnx", untrusted=True)
    assert calls == [], "torch.load must not run on a refused checkpoint"


def test_untrusted_directory_and_small_records_are_bounded_before_they_are_read(tmp_path, monkeypatch):
    import torch
    import zipfile
    monkeypatch.setattr(torch, "load", lambda *a, **k: (_ for _ in ()).throw(AssertionError("loaded")))
    # An end record announcing more entries than allowed: refused before zipfile parses the directory.
    inflated = tmp_path / "inflated.pth"
    with zipfile.ZipFile(inflated, "w") as archive:
        archive.writestr("model/data.pkl", b"x")
    raw = bytearray(inflated.read_bytes())
    end = raw.rfind(b"PK\x05\x06")
    raw[end + 8:end + 12] = (converter.MAX_RECORDS + 1).to_bytes(2, "little") * 2
    inflated.write_bytes(bytes(raw))
    real_zipfile = converter.zipfile.ZipFile
    monkeypatch.setattr(converter.zipfile, "ZipFile", lambda *a, **k: (_ for _ in ()).throw(AssertionError("parsed")))
    with pytest.raises(ValueError, match="limites"):
        converter.export_model(inflated, tmp_path / "a.onnx", untrusted=True)
    monkeypatch.setattr(converter.zipfile, "ZipFile", real_zipfile)
    # Past 65535 entries the count lives in the zip64 end record: read from there too.
    zip64 = tmp_path / "zip64.pth"
    with zipfile.ZipFile(zip64, "w") as archive:
        for i in range(0x10000):
            archive.writestr(f"m/data/{i}", b"")
    assert converter._directory_size(zip64)[0] == 0x10000
    with pytest.raises(ValueError, match="limites"):
        converter.export_model(zip64, tmp_path / "b.onnx", untrusted=True)
    # Layouts the readers could interpret differently are refused, not guessed.
    plain = tmp_path / "plain.pth"
    with zipfile.ZipFile(plain, "w") as archive:
        archive.writestr("m/data.pkl", b"x")
    raw = plain.read_bytes()
    end = raw.rfind(b"PK\x05\x06")
    directory_start = int.from_bytes(raw[end + 16:end + 20], "little")
    assert converter._directory_size(plain) == (1, end - directory_start)
    # A zip64 locator and end record inserted before an unsaturated end record: zipfile would
    # take the zip64 sizes, a reader trusting the classic record would not.
    forged_record = converter._ZIP64_EOCD.pack(b"PK\x06\x06", 44, 45, 45, 0, 0, 1, 1, 10**9, directory_start)
    forged_locator = converter._ZIP64_LOCATOR.pack(b"PK\x06\x07", 0, end, 1)
    variants = {
        "zip64 records disagreeing with the end record": raw[:end] + forged_record + forged_locator + raw[end:],
        "a trailing comment": raw[:-2] + (4).to_bytes(2, "little") + b"PK\x05",
        "bytes after the end record": raw + b"\0" * 8,
        "a directory not ending at the end records": raw[:end] + b"\0" * 16 + raw[end:],
    }
    for label, content in variants.items():
        crafted = tmp_path / "crafted.pth"
        crafted.write_bytes(content)
        monkeypatch.setattr(converter.zipfile, "ZipFile", lambda *a, **k: (_ for _ in ()).throw(AssertionError("parsed")))
        # Refused before zipfile builds the directory (some are not even seen as a zip).
        with pytest.raises(ValueError, match="limites|trop ancien"):
            converter.export_model(crafted, tmp_path / "x.onnx", untrusted=True)
        monkeypatch.setattr(converter.zipfile, "ZipFile", real_zipfile)
    # PyTorch reads `version` (like data.pkl) whole: it counts against the metadata budget.
    big_version = tmp_path / "version.pth"
    with zipfile.ZipFile(big_version, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("m/data.pkl", b"x")
        archive.writestr("m/version", b"3" * converter.MAX_METADATA_BYTES)
    with pytest.raises(ValueError, match="limites"):
        converter.export_model(big_version, tmp_path / "c.onnx", untrusted=True)


def test_untrusted_checkpoints_need_a_patched_pytorch(tmp_path, monkeypatch):
    import torch
    monkeypatch.setattr(torch, "load", lambda *a, **k: (_ for _ in ()).throw(AssertionError("loaded")))
    monkeypatch.setattr(torch, "__version__", "2.9.1+cpu")
    source = tmp_path / "model.pth"
    source.write_bytes(b"unused")
    with pytest.raises(ValueError, match="PyTorch trop ancien"):
        converter.export_model(source, tmp_path / "a.onnx", untrusted=True)
    assert converter._torch_release("2.10.0+cpu") >= converter.MIN_UNTRUSTED_TORCH > converter._torch_release("2.9.1")


def test_the_pack_pins_a_patched_pytorch():
    pins = dict(line.split("==", 1) for line in (ROOT / "requirements.txt").read_text().splitlines()
                if "==" in line and not line.startswith("#"))
    assert converter._torch_release(pins["torch"]) >= converter.MIN_UNTRUSTED_TORCH


def test_local_import_keeps_legacy_checkpoints_and_maps_zip_ones(tmp_path, monkeypatch):
    import torch
    calls = []
    monkeypatch.setattr(torch, "load", lambda *a, **k: calls.append(k) or {"version": "v1"})
    legacy = tmp_path / "legacy.pth"
    torch.save({"version": "v2"}, legacy, _use_new_zipfile_serialization=False)
    modern = tmp_path / "modern.pth"
    torch.save({"version": "v2"}, modern)
    for source in (legacy, modern):
        with pytest.raises(ValueError, match="RVC v2"):
            converter.export_model(source, tmp_path / "c.onnx")
    assert [c["mmap"] for c in calls] == [False, True]
    assert all(c["weights_only"] for c in calls)
    # The same zip checkpoint passes the untrusted checks and is memory-mapped too.
    with pytest.raises(ValueError, match="RVC v2"):
        converter.export_model(modern, tmp_path / "d.onnx", untrusted=True)
    assert calls[-1]["mmap"] is True


def test_refused_checkpoints_never_reach_the_memory_ceiling_and_local_ones_have_none(tmp_path, memory_limits):
    legacy = tmp_path / "legacy.pth"
    legacy.write_bytes(b"not a zip")
    with pytest.raises(ValueError):
        converter.export_model(legacy, tmp_path / "a.onnx", untrusted=True)
    with pytest.raises(Exception):
        converter.export_model(legacy, tmp_path / "b.onnx")
    assert memory_limits == []


@pytest.mark.skipif(sys.platform == "win32", reason="RLIMIT_AS path; Windows uses a job object")
def test_the_memory_ceiling_fails_the_conversion(tmp_path):
    """The real limit_memory, in a converter process of its own: past the ceiling torch.load
    fails, the converter exits 1 and publishes nothing."""
    import subprocess
    import torch
    torch.save({"config": [], "weight": {"w": torch.zeros(4 * 1024 * 1024)}, "version": "v2", "f0": 1},
               tmp_path / "model.pth")
    def convert(budget: str, output: str):
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]); import convert_rvc as c\n"
            f"c.MAX_UNTRUSTED_MEMORY = {budget}\n"
            "sys.argv = ['convert_rvc.py', '--pth', sys.argv[2], '--output', sys.argv[3], '--id', 'x', '--name', 'x', '--untrusted']\n"
            "raise SystemExit(c.main())\n"
        )
        return subprocess.run([sys.executable, "-I", "-c", script, str(ROOT), str(tmp_path / "model.pth"),
                               str(tmp_path / output)], capture_output=True, text=True, timeout=300)
    capped = convert("1", "capped")
    assert capped.returncode == 1 and "Échec de conversion" in capped.stderr, capped.stderr
    assert "memory" in capped.stderr.lower() and "Configuration" not in capped.stderr, capped.stderr
    assert not (tmp_path / "capped" / "meta.json").exists()
    # Control: with the shipped budget the same file loads and is refused by validation instead.
    roomy = convert("c.MAX_UNTRUSTED_MEMORY", "roomy")
    assert roomy.returncode == 1 and "Configuration RVC incorrecte" in roomy.stderr, roomy.stderr
