#!/usr/bin/env python3
"""Packaging-time only: fetch checksum-pinned shared networks. No app runtime calls."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def fetch_asset(asset: dict, target: Path) -> Path:
    name = asset["filename"]
    if Path(name).name != name or name in (".", ".."):
        raise ValueError("Invalid asset filename")
    destination = target / name
    target.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        with destination.open("rb") as cached:
            if hashlib.file_digest(cached, "sha256").hexdigest() == asset["sha256"]:
                return destination
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        digest = hashlib.sha256()
        with urllib.request.urlopen(asset["url"], timeout=120) as response, temporary.open("wb") as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != asset["sha256"]:
            raise ValueError(f"SHA256 mismatch for {name}: {digest.hexdigest()}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name("assets.json").read_text(encoding="utf-8"))
    for asset in manifest["assets"]:
        print(fetch_asset(asset, args.target), flush=True)
    # Ship these notices alongside weights, even when downloads are cached.
    notices = Path(__file__).with_name("licenses")
    for source in notices.iterdir():
        (args.target / source.name).write_bytes(source.read_bytes())
    (args.target / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
