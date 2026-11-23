#!/usr/bin/env bash
# Publishes a GitHub release for the commit TARGET_SHA, safely rerunnable.
#   publish_release.sh <tag> <title> <notes> <file>...
# notes: "generate" for notes generated from the merged PRs, else the text itself.
# Never marks the release as latest (the CI "latest" job does that).
# Needs GH_TOKEN, REPO and TARGET_SHA.
set -euo pipefail

tag=$1 title=$2 notes=$3
shift 3

# github.token cannot create a tag on a commit whose workflow files differ from
# the default branch (GitHub requires the "workflows" permission). That only
# happens when a newer merge changed the workflows while this one was building:
# by decision, this commit then ships in that newer merge's release (the pack
# workflow also runs on every workflow change, so the pack is rebuilt too).
workflows() {
  gh api "repos/$REPO/contents/.github/workflows?ref=$1" --jq '[.[] | {name, sha}] | sort_by(.name)'
}
diverged() {
  local branch here there
  # Explicit exits: errexit does not apply inside an `if` condition.
  branch=$(gh api "repos/$REPO" --jq .default_branch) || exit 1
  here=$(workflows "$TARGET_SHA") || exit 1
  there=$(workflows "$branch") || exit 1
  [ "$here" != "$there" ]
}
skip() {
  echo "::notice::$tag skipped: the workflows changed on the default branch since this commit; it ships in the next release built from it."
  exit 0
}
# Creating the tag is the only step GitHub can refuse for diverged workflows
# (as a 403, a 404 or an explicit message). So the tag is created on its own,
# first: if that fails and the workflows diverged, skip; any other failure,
# and every later step (uploads, publication), fails the job as usual.
ensure_tag() {
  if gh api "repos/$REPO/git/ref/tags/$tag" > /dev/null 2>&1; then
    return 0
  fi
  local status=0
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$tag" -f sha="$TARGET_SHA" > /dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  if diverged; then
    skip
  fi
  exit "$status"
}

# A rerun of a run that already published (or was interrupted while
# publishing, which leaves a draft): add what is missing, then publish.
if gh release view "$tag" --repo "$REPO" > /dev/null 2>&1; then
  present=$(gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[] | select(.state == "uploaded") | .name')
  for file in "$@"; do
    if ! grep -qxF "$(basename "$file")" <<< "$present"; then
      gh release upload "$tag" "$file" --repo "$REPO" --clobber
    fi
  done
  draft=$(gh release view "$tag" --repo "$REPO" --json isDraft --jq .isDraft)
  if [ "$draft" = true ]; then
    ensure_tag
    gh release edit "$tag" --repo "$REPO" --draft=false --latest=false
  fi
  echo "$tag published"
  exit 0
fi

if diverged; then
  skip
fi
ensure_tag
# The tag exists: the release is attached to it, nothing else creates a tag.
args=(--repo "$REPO" --verify-tag --title "$title" --latest=false)
if [ "$notes" = generate ]; then
  args+=(--generate-notes)
else
  args+=(--notes "$notes")
fi
gh release create "$tag" "$@" "${args[@]}"
