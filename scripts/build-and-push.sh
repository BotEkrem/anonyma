#!/usr/bin/env bash
# Build Anonyma app images on this machine and push to the private registry.
# The deployment host is sized to run the stack, not compile it.
#
# Usage:
#   REGISTRY_HOST=<registry-host> ./scripts/build-and-push.sh
#   REGISTRY_HOST=<registry-host> SERVICES=web ./scripts/build-and-push.sh
#   IMAGE_TAG=<tag> REGISTRY_HOST=<registry-host> ./scripts/build-and-push.sh
#
# Sign in once:  docker login <registry-host>
#
# Default TARGET_PLATFORM is linux/amd64 (cluster arch). On Apple Silicon that
# means QEMU for amd64 images — slower than a native arm64 build (realtime
# cross-compiles natively instead). Override only if you know why:
# TARGET_PLATFORM=linux/amd64
#
# After the pushes, older images of each built service are deleted from the
# registry, keeping the newest PRUNE_KEEP (default 5; 0 turns it off). See
# scripts/prune-registry.py. The registry's own garbage collection then frees
# the space.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${REGISTRY_HOST:?set REGISTRY_HOST to your private registry host}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${TARGET_PLATFORM:-linux/amd64}"

if [[ -n "${SERVICES:-}" ]]; then
  IFS=',' read -r -a SERVICES_ARR <<<"${SERVICES}"
else
  SERVICES_ARR=(web realtime)
fi

dockerfile_for() {
  case "$1" in
    web) echo deploy/docker/Dockerfile.web ;;
    realtime) echo deploy/docker/Dockerfile.realtime ;;
    gateway|core|match) echo deploy/docker/Dockerfile.nest ;;
    *) return 1 ;;
  esac
}

echo "==> Target platform: ${PLATFORM} (host: $(uname -m))"
echo "==> Registry: ${REGISTRY_HOST}  tag: ${IMAGE_TAG}"
echo "==> Services: ${SERVICES_ARR[*]}"

for svc in "${SERVICES_ARR[@]}"; do
  df="$(dockerfile_for "$svc")" || {
    echo "ERROR: unknown service: ${svc}" >&2
    exit 1
  }
  image="${REGISTRY_HOST}/anonyma/${svc}:${IMAGE_TAG}"
  echo "==> Building + pushing ${image}"
  build_args=(buildx build --platform "${PLATFORM}" -f "$df")
  if [[ "$svc" == gateway || "$svc" == core || "$svc" == match ]]; then
    build_args+=(--build-arg "APP=${svc}")
  fi
  build_args+=(-t "$image" --push .)
  docker "${build_args[@]}"
  echo "==> OK ${image}"
done

PRUNE_KEEP="${PRUNE_KEEP:-5}"
if [[ "${PRUNE_KEEP}" != 0 ]]; then
  echo "==> Pruning older images (keeping ${PRUNE_KEEP} per service)"
  prune_repos=()
  for svc in "${SERVICES_ARR[@]}"; do
    prune_repos+=("${REGISTRY_HOST}/anonyma/${svc}")
  done
  # The new images are already pushed; a failed prune is only a warning.
  python3 -I scripts/prune-registry.py --keep "${PRUNE_KEEP}" "${prune_repos[@]}" ||
    echo "WARNING: registry prune failed; images were pushed" >&2
fi

echo "==> Next on the deploy host (cluster pulls; no *:local retag):"
echo "    REGISTRY_HOST=${REGISTRY_HOST} IMAGE_TAG=${IMAGE_TAG} ./scripts/deploy-from-registry.sh ${SERVICES_ARR[*]}"
