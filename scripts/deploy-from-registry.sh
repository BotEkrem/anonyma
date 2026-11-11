#!/usr/bin/env bash
# On the deploy host (amd64 k3s): point Anonyma Deployments at private-registry
# images and let the cluster pull them (imagePullPolicy: IfNotPresent + pull secret).
#
# Run ON THE SERVER after local build-and-push:
#   REGISTRY_HOST=<registry-host> IMAGE_TAG=<tag> \
#     ./scripts/deploy-from-registry.sh web realtime
#
# Optional: REGISTRY_USER / REGISTRY_PASSWORD (otherwise docker config.json auth).
# Requires: kubectl, anonyma namespace, docker login to REGISTRY_HOST (or env creds).
set -euo pipefail

: "${REGISTRY_HOST:?set REGISTRY_HOST}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NS="${NS:-anonyma}"
PULL_SECRET="${PULL_SECRET:-anonyma-registry}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <service> [service...]" >&2
  exit 1
fi

ensure_pull_secret() {
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN
  python3 - <<'PY' "$REGISTRY_HOST" "$tmp"
import base64, json, os, sys
host, out = sys.argv[1], sys.argv[2]
user = os.environ.get("REGISTRY_USER", "").strip()
passwd = os.environ.get("REGISTRY_PASSWORD", "").strip()
if not (user and passwd):
    cfg = None
    for p in (os.path.expanduser("~/.docker/config.json"), "/root/.docker/config.json"):
        if os.path.isfile(p):
            with open(p) as f:
                cfg = json.load(f)
            break
    if not cfg:
        raise SystemExit("no docker config.json; set REGISTRY_USER/REGISTRY_PASSWORD or docker login")
    auths = cfg.get("auths") or {}
    entry = (
        auths.get(host)
        or auths.get(f"https://{host}")
        or auths.get(f"https://{host}/v2/")
    )
    if not entry:
        for k, v in auths.items():
            if host in k:
                entry = v
                break
    if not entry:
        raise SystemExit(f"no docker auth for {host}; docker login {host} or set REGISTRY_USER/REGISTRY_PASSWORD")
    if entry.get("auth"):
        raw = base64.b64decode(entry["auth"]).decode()
        user, _, passwd = raw.partition(":")
    elif entry.get("username") and entry.get("password"):
        user, passwd = entry["username"], entry["password"]
    else:
        raise SystemExit("docker auth entry missing username/password")
auth_b64 = base64.b64encode(f"{user}:{passwd}".encode()).decode()
doc = {"auths": {host: {"auth": auth_b64}}}
with open(out, "w") as f:
    json.dump(doc, f)
PY
  kubectl -n "$NS" create secret generic "$PULL_SECRET" \
    --type=kubernetes.io/dockerconfigjson \
    --from-file=.dockerconfigjson="$tmp" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "==> Pull secret ${NS}/${PULL_SECRET} ok"
}

ensure_pull_secret

for svc in "$@"; do
  remote="${REGISTRY_HOST}/anonyma/${svc}:${IMAGE_TAG}"
  echo "==> Set image deploy/${svc} → ${remote}"
  kubectl -n "$NS" set image "deploy/${svc}" "${svc}=${remote}"
  # Keep pull policy + secret even if an older apply left Never / no secret.
  kubectl -n "$NS" patch "deploy/${svc}" --type strategic -p \
    "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"${PULL_SECRET}\"}],\"containers\":[{\"name\":\"${svc}\",\"imagePullPolicy\":\"IfNotPresent\"}]}}}}" \
    >/dev/null
  echo "==> Rollout deploy/${svc}"
  kubectl -n "$NS" rollout status "deploy/${svc}" --timeout=240s
done

echo DEPLOY_OK
kubectl -n "$NS" get pods -l "app in ($(IFS=,; echo "$*"))" -o wide 2>/dev/null || \
  kubectl -n "$NS" get pods -o wide
