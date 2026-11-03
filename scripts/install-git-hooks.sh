#!/usr/bin/env bash
# One-shot installer for the SCNS anti-drift git hooks (M1).
#
# Routes this clone's hooks to the versioned scripts/git-hooks/ directory via
# core.hooksPath. Idempotent — safe to re-run. The setting is shared-config, so
# it covers every worktree of the clone; the relative path resolves against
# each worktree's own checkout of scripts/git-hooks/.
#
# Run once per clone:  bash scripts/install-git-hooks.sh

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)

git -C "$repo_root" config core.hooksPath scripts/git-hooks
chmod +x "$repo_root"/scripts/git-hooks/pre-commit "$repo_root"/scripts/git-hooks/pre-push

echo "[scns-git-hooks] installed: core.hooksPath -> scripts/git-hooks (main is now PR-only; escape hatch SCNS_ALLOW_MAIN_PUSH=1)"
