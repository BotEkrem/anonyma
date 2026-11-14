#!/bin/bash
# Bootstrap Anonyma onto single-node k3s with private-registry image pulls.
# Requires REGISTRY_HOST (and docker login / REGISTRY_USER+REGISTRY_PASSWORD).
#
# Hostnames are placeholders in git (*.example.com). This script rewrites them at
# apply time from production.env — never commit real ops/product hosts into YAML.
#   PUBLIC_HOST=chat.example.com          # product ingress + PUBLIC_* URLs
#   OPS_DOMAIN=example.com                # → grafana.$OPS_DOMAIN, headlamp.$OPS_DOMAIN
#   # or: GRAFANA_HOST=...  HEADLAMP_HOST=...
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="${ENV_DIR:?set ENV_DIR to a directory containing production.env}"
REPO_ROOT="$(cd "$ROOT/../../../.." && pwd)"
RMQ_CERT_DIR="${RMQ_CERT_DIR:-/var/lib/anonyma/rmq-certs}"
: "${REGISTRY_HOST:?set REGISTRY_HOST to your private registry host}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Resolve PUBLIC_HOST / ops panel hosts from ENV_DIR (env vars override file).
eval "$(python3 - <<'PY' "$ENV_DIR"
import os, shlex, sys
from pathlib import Path
from urllib.parse import urlparse
vals = {}
env_dir = Path(sys.argv[1])
for p in (env_dir / "production.env", env_dir / ".env", env_dir):
    if not p.is_file():
        continue
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        vals.setdefault(k.strip(), v.strip().strip('"').strip("'"))
for k in ("PUBLIC_HOST", "DOMAIN", "PUBLIC_WEB_ORIGIN", "OPS_DOMAIN", "GRAFANA_HOST", "HEADLAMP_HOST", "LIVEKIT_URL"):
    if os.environ.get(k):
        vals[k] = os.environ[k].strip()
public = vals.get("PUBLIC_HOST") or vals.get("DOMAIN") or ""
if not public:
    origin = vals.get("PUBLIC_WEB_ORIGIN") or ""
    if origin:
        public = urlparse(origin).hostname or ""
ops = vals.get("OPS_DOMAIN") or ""
grafana = vals.get("GRAFANA_HOST") or (f"grafana.{ops}" if ops else "")
headlamp = vals.get("HEADLAMP_HOST") or (f"headlamp.{ops}" if ops else "")
if not public:
    raise SystemExit("set PUBLIC_HOST or DOMAIN (or PUBLIC_WEB_ORIGIN) in production.env")
if not grafana or not headlamp:
    raise SystemExit("set OPS_DOMAIN or both GRAFANA_HOST and HEADLAMP_HOST in production.env")
print(f"export PUBLIC_HOST={shlex.quote(public)}")
print(f"export GRAFANA_HOST={shlex.quote(grafana)}")
print(f"export HEADLAMP_HOST={shlex.quote(headlamp)}")
# The page CSP lets it reach the LiveKit host; without voice it stays a placeholder.
livekit = urlparse(vals.get("LIVEKIT_URL") or "").hostname or "rtc.example.com"
print(f"export LIVEKIT_HOST={shlex.quote(livekit)}")
PY
)"
echo "== hosts PUBLIC_HOST=${PUBLIC_HOST} GRAFANA_HOST=${GRAFANA_HOST} HEADLAMP_HOST=${HEADLAMP_HOST} =="

need() { command -v "$1" >/dev/null || { echo "missing $1"; exit 1; }; }
need kubectl
need k3s
need python3
need openssl

echo "== rewrite overlay images for ${REGISTRY_HOST} tag=${IMAGE_TAG} =="
python3 - <<'PY' "$ROOT/kustomization.yaml" "$REGISTRY_HOST" "$IMAGE_TAG"
from pathlib import Path
import re, sys
path, host, tag = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
for svc in ("gateway", "core", "match", "realtime", "web"):
    text = re.sub(
        rf"(- name: anonyma/{svc}\n\s+newName: ).+",
        rf"\g<1>{host}/anonyma/{svc}",
        text,
    )
    text = re.sub(
        rf"(- name: anonyma/{svc}\n\s+newName: {re.escape(host)}/anonyma/{svc}\n\s+newTag: ).+",
        rf"\g<1>{tag}",
        text,
    )
path.write_text(text)
print("images ok")
PY

echo "== registry pull secret =="
# Namespace may not exist yet — create it so the pull secret can land before apply -k.
kubectl get ns anonyma >/dev/null 2>&1 || kubectl create ns anonyma
# Reuse deploy-from-registry secret logic via a no-op service skip: create secret only.
python3 - <<'PY' "$REGISTRY_HOST"
import base64, json, os, subprocess, sys, tempfile
host = sys.argv[1]
ns = os.environ.get("NS", "anonyma")
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
        raise SystemExit("docker login required for REGISTRY_HOST before bootstrap")
    auths = cfg.get("auths") or {}
    entry = auths.get(host) or auths.get(f"https://{host}") or auths.get(f"https://{host}/v2/")
    if not entry:
        for k, v in auths.items():
            if host in k:
                entry = v
                break
    if not entry:
        raise SystemExit(f"no docker auth for {host}")
    if entry.get("auth"):
        raw = base64.b64decode(entry["auth"]).decode()
        user, _, passwd = raw.partition(":")
    else:
        user, passwd = entry["username"], entry["password"]
auth_b64 = base64.b64encode(f"{user}:{passwd}".encode()).decode()
doc = {"auths": {host: {"auth": auth_b64}}}
cfg_path = tempfile.mktemp(suffix=".dockerconfigjson")
yaml_path = cfg_path + ".yaml"
with open(cfg_path, "w") as f:
    json.dump(doc, f)
with open(yaml_path, "w") as out:
    subprocess.check_call([
        "kubectl", "-n", ns, "create", "secret", "generic", "anonyma-registry",
        "--type=kubernetes.io/dockerconfigjson",
        f"--from-file=.dockerconfigjson={cfg_path}",
        "--dry-run=client", "-o", "yaml",
    ], stdout=out)
subprocess.check_call(["kubectl", "apply", "-f", yaml_path])
os.unlink(cfg_path)
os.unlink(yaml_path)
print("pull secret ok")
PY

echo "== rabbitmq TLS certs =="
mkdir -p "$RMQ_CERT_DIR"
if [ -f "$REPO_ROOT/deploy/docker/rmq-gen-certs.sh" ]; then
  sh "$REPO_ROOT/deploy/docker/rmq-gen-certs.sh" "$RMQ_CERT_DIR"
else
  # Fallback when overlay is copied without full repo.
  sh -c 'DIR="$1"; cd "$DIR"; [ -f ca.pem ] && exit 0; openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=anonyma-rmq-ca" -keyout ca-key.pem -out ca.pem; openssl req -newkey rsa:2048 -nodes -subj "/CN=rabbitmq" -keyout server-key.pem -out server.csr; openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server.pem -days 3650 -extfile <(printf "subjectAltName=DNS:rabbitmq,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"); openssl req -newkey rsa:2048 -nodes -subj "/CN=anonyma-client" -keyout client-key.pem -out client.csr; openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client.pem -days 3650 -extfile <(printf "extendedKeyUsage=clientAuth"); rm -f server.csr client.csr ca.srl; chmod 644 ca.pem server.pem client.pem server-key.pem client-key.pem; rm -f ca-key.pem' _ "$RMQ_CERT_DIR"
fi

echo "== rabbitmq client certificate secret =="
# App pods get the client certificate only, never the CA or server keys.
kubectl -n anonyma create secret generic anonyma-rmq-client \
  --from-file=ca.pem="$RMQ_CERT_DIR/ca.pem" \
  --from-file=client.pem="$RMQ_CERT_DIR/client.pem" \
  --from-file=client-key.pem="$RMQ_CERT_DIR/client-key.pem" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== render secrets =="
python3 - <<'PY' "$ENV_DIR" "$ROOT"
import secrets, sys, urllib.parse
from pathlib import Path
env_dir, root = Path(sys.argv[1]), Path(sys.argv[2])
vals = {}
for p in (env_dir / "production.env", env_dir / ".env", env_dir):
    if not p.is_file():
        continue
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        vals.setdefault(k, v.strip().strip('"').strip("'"))
req = [
    "POSTGRES_PASSWORD", "MONGO_PASSWORD", "RABBITMQ_PASSWORD", "REDIS_PASSWORD",
    "MESSAGE_ENCRYPTION_KEY", "INTERNAL_RPC_SECRET", "WS_TICKET_SECRET",
    "IDENTITY_PEPPER", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
]
missing = [k for k in req if not vals.get(k)]
if missing:
    raise SystemExit(f"missing secrets: {missing}")

def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')

pg, mo, rq, rd = (vals[k] for k in ("POSTGRES_PASSWORD", "MONGO_PASSWORD", "RABBITMQ_PASSWORD", "REDIS_PASSWORD"))
pg_e, mo_e, rq_e, rd_e = map(urllib.parse.quote, (pg, mo, rq, rd))

(root / "secrets.yaml").write_text(f'''apiVersion: v1
kind: Secret
metadata:
  name: anonyma-secrets
  namespace: anonyma
type: Opaque
stringData:
  POSTGRES_PASSWORD: "{esc(pg)}"
  MONGO_PASSWORD: "{esc(mo)}"
  RABBITMQ_PASSWORD: "{esc(rq)}"
  REDIS_PASSWORD: "{esc(rd)}"
  MESSAGE_ENCRYPTION_KEY: "{esc(vals["MESSAGE_ENCRYPTION_KEY"])}"
  INTERNAL_RPC_SECRET: "{esc(vals["INTERNAL_RPC_SECRET"])}"
  WS_TICKET_SECRET: "{esc(vals["WS_TICKET_SECRET"])}"
  DATABASE_URL: "postgresql://anonyma:{pg_e}@postgres:5432/anonyma"
  MONGO_URI: "mongodb://anonyma:{mo_e}@mongo:27017/anonyma?authSource=admin"
  REDIS_URL: "redis://:{rd_e}@redis:6379"
  RABBITMQ_URL: "amqps://anonyma:{rq_e}@rabbitmq:5671"
''')
(root / "secrets.yaml").chmod(0o600)

gw = f'''apiVersion: v1
kind: Secret
metadata:
  name: anonyma-gateway-secrets
  namespace: anonyma
type: Opaque
stringData:
  IDENTITY_PEPPER: "{esc(vals["IDENTITY_PEPPER"])}"
  TURNSTILE_SITE_KEY: "{esc(vals["TURNSTILE_SITE_KEY"])}"
  TURNSTILE_SECRET_KEY: "{esc(vals["TURNSTILE_SECRET_KEY"])}"
'''
for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
    if vals.get(k):
        gw += f'  {k}: "{esc(vals[k])}"\n'
(root / "gateway-secrets.yaml").write_text(gw)
(root / "gateway-secrets.yaml").chmod(0o600)

def live_grafana(key: str) -> str:
    """The value already in the cluster: Grafana keeps its first password, so a
    rerun must not mint a new one that no longer matches the real login."""
    import base64, subprocess
    try:
        out = subprocess.run(
            ["kubectl", "-n", "anonyma", "get", "secret", "anonyma-grafana",
             "-o", f"jsonpath={{.data.{key}}}"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return base64.b64decode(out).decode() if out else ""
    except Exception:
        return ""
graf_user = vals.get("GRAFANA_ADMIN_USER") or live_grafana("GF_SECURITY_ADMIN_USER") or "admin"
graf_pass = (
    vals.get("GRAFANA_ADMIN_PASSWORD")
    or live_grafana("GF_SECURITY_ADMIN_PASSWORD")
    or secrets.token_urlsafe(24)
)
(root / "grafana-secret.yaml").write_text(f'''apiVersion: v1
kind: Secret
metadata:
  name: anonyma-grafana
  namespace: anonyma
type: Opaque
stringData:
  GF_SECURITY_ADMIN_USER: "{esc(graf_user)}"
  GF_SECURITY_ADMIN_PASSWORD: "{esc(graf_pass)}"
''')
(root / "grafana-secret.yaml").chmod(0o600)
# Persist generated grafana password for the operator (root-only).
Path("/root/anonyma-grafana-admin.txt").write_text(f"{graf_user}\n{graf_pass}\n")
Path("/root/anonyma-grafana-admin.txt").chmod(0o600)
print("wrote secrets; livekit=", bool(vals.get("LIVEKIT_URL")), "grafana_user=", graf_user)
PY

# Rewrite *.example.com placeholders → real hosts without dirtying the git tree.
rewrite_hosts() {
  PUBLIC_HOST="$PUBLIC_HOST" GRAFANA_HOST="$GRAFANA_HOST" HEADLAMP_HOST="$HEADLAMP_HOST" LIVEKIT_HOST="$LIVEKIT_HOST" python3 - <<'PY'
import os, sys
text = sys.stdin.read()
repl = {
    "chat.example.com": os.environ["PUBLIC_HOST"],
    "rtc.example.com": os.environ["LIVEKIT_HOST"],
    "grafana.example.com": os.environ["GRAFANA_HOST"],
    "headlamp.example.com": os.environ["HEADLAMP_HOST"],
}
# Longest first so partial overlaps cannot corrupt replacements.
for old in sorted(repl, key=len, reverse=True):
    text = text.replace(old, repl[old])
sys.stdout.write(text)
PY
}

echo "== kubectl apply -k (hosts rewritten) =="
kubectl kustomize --load-restrictor LoadRestrictionsNone "$ROOT" | rewrite_hosts | kubectl apply -f -

echo "== out-of-namespace ingress (headlamp + nginx config) =="
if [ -f "$ROOT/ingress-headlamp.yaml" ]; then
  rewrite_hosts <"$ROOT/ingress-headlamp.yaml" | kubectl apply -f -
fi
if [ -f "$ROOT/ingress-nginx-config.yaml" ]; then
  kubectl apply -f "$ROOT/ingress-nginx-config.yaml"
fi

echo "== wait workloads =="
for d in postgres mongo redis rabbitmq core gateway match realtime web prometheus grafana kube-state-metrics; do
  kubectl -n anonyma rollout status deploy/"$d" --timeout=240s || true
done

echo "== status =="
kubectl -n anonyma get pods,svc
kubectl -n anonyma get ingress 2>/dev/null || true
curl -sS -o /dev/null -w "web_nodeport=%{http_code}\n" http://127.0.0.1:30080/ || true
curl -sS -o /dev/null -w "grafana_nodeport=%{http_code}\n" http://127.0.0.1:30300/login || true
free -h | head -2
echo "grafana admin file: /root/anonyma-grafana-admin.txt"
