#!/usr/bin/env bash
# bash scripts/publish_release.test.sh
# Replays interrupted publications of scripts/publish_release.sh against a fake `gh` that
# keeps each asset's content, and checks that a published release never mixes two builds.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'PY'
#!/usr/bin/env python3
import json, os, sys
st = os.environ["FAKE_STATE"]
s = json.load(open(st))
a = sys.argv[1:]
def save(): json.dump(s, open(st, "w"))
s["calls"] = s.get("calls", []) + [" ".join(a[:3])]
save()
rel = s["releases"].get(a[2]) if len(a) > 2 else None
if a[:2] == ["release", "view"]:
    if rel is None: sys.exit(1)
    if "isDraft" in a: print("true" if rel["draft"] else "false")
    elif "--json" in a: print("\n".join(rel["assets"]))
    sys.exit(0)
if a[:2] == ["release", "upload"]:
    s["uploads"] = s.get("uploads", 0) + 1
    save()
    if int(os.environ.get("FAIL_AT", "0")) == s["uploads"]: sys.exit(1)
    rel["assets"][os.path.basename(a[3])] = open(a[3]).read().strip()
    save(); sys.exit(0)
if a[:2] == ["release", "edit"]:
    rel["draft"] = "--draft=true" in a
    save(); sys.exit(0)
if a[:2] == ["release", "create"]:
    files = [x for x in a[3:] if os.path.isfile(x)]
    s["releases"][a[2]] = {"draft": False, "assets": {os.path.basename(f): open(f).read().strip() for f in files}}
    save(); sys.exit(0)
if a[0] == "api":
    if a[1] == "repos/o/r": print("main"); sys.exit(0)
    if "git/ref/tags/" in a[1] or "git/refs" in a[1]: sys.exit(0)
    if "contents/.github/workflows" in a[1]: print("same"); sys.exit(0)
sys.exit(2)
PY
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FAKE_STATE="$work/state.json" REPO=o/r TARGET_SHA=abc

for build in A B C; do
  mkdir -p "$work/$build"
  echo "installer-$build" > "$work/$build/VoxBox_1_x64-setup.exe"
  echo "manifest-$build" > "$work/$build/latest.json"
done
publish() { "$here/publish_release.sh" v9 "VoxBox 9" generate "$work/$1/VoxBox_1_x64-setup.exe" "$work/$1/latest.json"; }
state() { python3 -c "import json,sys; r=json.load(open('$FAKE_STATE'))['releases']['v9']; print(('draft' if r['draft'] else 'published'), r['assets'].get('VoxBox_1_x64-setup.exe'), r['assets'].get('latest.json'))"; }
# An interrupted upload must fail the release job, not report success.
fails() {
  if "$@" > /dev/null 2>&1; then echo "FAIL: '$*' succeeded despite the interruption"; exit 1; fi
}
expect() {
  local got; got=$(state)
  if [ "$got" != "$1" ]; then echo "FAIL $2: expected '$1', got '$got'"; exit 1; fi
  echo "ok - $2"
}

# A draft holding only build A's manifest; a retry with build B dies after the installer.
echo '{"releases":{"v9":{"draft":true,"assets":{"latest.json":"manifest-A"}}}}' > "$FAKE_STATE"
FAIL_AT=2 fails publish B
expect "draft installer-B manifest-A" "interrupted draft retry stays unpublished"
publish C > /dev/null
expect "published installer-C manifest-C" "next draft retry publishes one build's pair"

# A published release that lost its installer; the repair dies after the installer.
echo '{"releases":{"v9":{"draft":false,"assets":{"latest.json":"manifest-A"}}}}' > "$FAKE_STATE"
FAIL_AT=1 fails publish B
expect "draft None manifest-A" "repair takes the release back to draft first"
echo '{"releases":{"v9":{"draft":false,"assets":{"latest.json":"manifest-A"}}},"uploads":0}' > "$FAKE_STATE"
FAIL_AT=2 fails publish B
expect "draft installer-B manifest-A" "interrupted repair is not published"
publish C > /dev/null
expect "published installer-C manifest-C" "next retry publishes one build's pair"

# A published, complete release is left alone.
echo '{"releases":{"v9":{"draft":false,"assets":{"VoxBox_1_x64-setup.exe":"installer-A","latest.json":"manifest-A"}}}}' > "$FAKE_STATE"
publish C > /dev/null
expect "published installer-A manifest-A" "complete published release untouched"

# First publication.
echo '{"releases":{}}' > "$FAKE_STATE"
publish A > /dev/null
expect "published installer-A manifest-A" "first publication"
