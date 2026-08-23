#!/usr/bin/env bash
set -euo pipefail

: "${MOUNT_GIT_REMOTE:?MOUNT_GIT_REMOTE is required}"
: "${MOUNT_GIT_BRANCH:=main}"
: "${MOUNT_REPO_NAME:?MOUNT_REPO_NAME is required}"
: "${MOUNT_ROOT:=/workspace/mnt}"
: "${ARTIFACT_FS_ROOT:=/tmp/artifact-fs}"
: "${ARTIFACTS_AUTHORIZATION:?ARTIFACTS_AUTHORIZATION is required}"

LOCK=/tmp/artifact-fs-mount.lock
PID=/tmp/artifact-fs-daemon.pid
LOG=/tmp/artifact-fs-daemon.log
MOUNT_PATH="${MOUNT_ROOT}/${MOUNT_REPO_NAME}"

exec 9>"$LOCK"
flock -w 120 9

if [ ! -e /dev/fuse ]; then
  echo "artifact-fs: /dev/fuse is not available" >&2
  exit 1
fi

if ! git check-ref-format --branch "$MOUNT_GIT_BRANCH" >/dev/null 2>&1; then
  echo "artifact-fs: invalid branch" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_FS_ROOT" "$MOUNT_ROOT"

# Keep the token out of the remote URL and process list. Git and ArtifactFS inherit
# this repo-specific HTTP header from global config inside the isolated sandbox.
git config --global http."$MOUNT_GIT_REMOTE".extraHeader "Authorization: $ARTIFACTS_AUTHORIZATION"

if ! artifact-fs status --name "$MOUNT_REPO_NAME" >/dev/null 2>&1; then
  artifact-fs add-repo \
    --name "$MOUNT_REPO_NAME" \
    --remote "$MOUNT_GIT_REMOTE" \
    --branch "$MOUNT_GIT_BRANCH" \
    --mount-root "$MOUNT_ROOT"
fi

if [ -f "$PID" ]; then
  existing=$(cat "$PID" 2>/dev/null || true)
  if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
    printf 'repo_name=%s\nmount_path=%s\n' "$MOUNT_REPO_NAME" "$MOUNT_PATH"
    exit 0
  fi
fi

nohup artifact-fs daemon --root "$MOUNT_ROOT" >"$LOG" 2>&1 </dev/null &
echo "$!" >"$PID"

for _ in $(seq 1 120); do
  if [ -e "$MOUNT_PATH/.git" ] && git -C "$MOUNT_PATH" rev-parse HEAD >/dev/null 2>&1; then
    printf 'repo_name=%s\nmount_path=%s\n' "$MOUNT_REPO_NAME" "$MOUNT_PATH"
    exit 0
  fi
  sleep 0.5
done

echo "artifact-fs: mount did not become ready" >&2
cat "$LOG" >&2 || true
exit 1
