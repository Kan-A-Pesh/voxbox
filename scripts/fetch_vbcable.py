"""Downloads the official VB-CABLE driver pack into installer/resources/vbcable/.

The pack is redistributed AS IS (unmodified) under VB-Audio's donationware terms:
https://vb-audio.com/Services/licensing.htm. Its binaries are never committed.
"""
import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
SHA256 = "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb"
DEST = Path(__file__).resolve().parent.parent / "installer" / "resources" / "vbcable"


def main() -> int:
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        print(f"VB-CABLE: sha256 inattendu {digest} (attendu {SHA256}); mettre à jour URL/SHA256", file=sys.stderr)
        return 1
    DEST.mkdir(parents=True, exist_ok=True)
    zipfile.ZipFile(io.BytesIO(data)).extractall(DEST)
    print(f"VB-CABLE extrait dans {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
