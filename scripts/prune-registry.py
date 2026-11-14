#!/usr/bin/env python3
"""Delete old images of the given repositories, keeping the newest few.

Usage: prune-registry.py [--keep N] [--dry-run] HOST/REPO [HOST/REPO ...]

Images are ordered by the build time in their config, not by tag name (tags
are commit hashes). Deleting goes by digest, and every tag on that digest goes
with it, so a digest that any kept tag points to is never deleted; identical
rebuilds share a digest under different tags. Child manifests of a deleted
index (platform images, build attestations) are deleted too, unless a kept
image uses them, so the registry's garbage collection can free their layers.

Credentials come from the Docker login (~/.docker/config.json: inline auth,
credHelpers or credsStore). Nothing is printed from them.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ACCEPT = ",".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


def docker_auth(host):
    path = os.path.join(os.environ.get("DOCKER_CONFIG", os.path.expanduser("~/.docker")), "config.json")
    with open(path) as f:
        cfg = json.load(f)
    inline = cfg.get("auths", {}).get(host, {}).get("auth")
    if inline:
        return "Basic " + inline
    helper = cfg.get("credHelpers", {}).get(host) or cfg.get("credsStore")
    if not helper:
        raise SystemExit(f"no Docker login for {host}")
    out = subprocess.run(
        [f"docker-credential-{helper}", "get"], input=host, capture_output=True, text=True, check=True
    ).stdout
    cred = json.loads(out)
    return "Basic " + base64.b64encode(f"{cred['Username']}:{cred['Secret']}".encode()).decode()


class Registry:
    def __init__(self, host):
        self.host = host
        self.auth = docker_auth(host)

    def call(self, path, method="GET"):
        req = urllib.request.Request(
            f"https://{self.host}{path}",
            method=method,
            headers={"Authorization": self.auth, "Accept": ACCEPT},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.headers, r.read()

    def json(self, path):
        return json.loads(self.call(path)[1])


def image_info(reg, repo, tag):
    """(digest, built-at, child digests) for one tag, or None if it vanished."""
    try:
        headers, body = reg.call(f"/v2/{repo}/manifests/{tag}")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise
    digest = headers.get("Docker-Content-Digest")
    manifest = json.loads(body)
    children = [m["digest"] for m in manifest.get("manifests", [])]
    image = manifest
    if children:
        # The image itself, not a build attestation (platform unknown/unknown).
        real = [m for m in manifest["manifests"] if m.get("platform", {}).get("os") != "unknown"]
        image = reg.json(f"/v2/{repo}/manifests/{(real or manifest['manifests'])[0]['digest']}")
    config = reg.json(f"/v2/{repo}/blobs/{image['config']['digest']}")
    return digest, config.get("created") or "", children


def prune(reg, repo, keep, dry_run):
    tags = reg.json(f"/v2/{repo}/tags/list").get("tags") or []
    images = {}
    for tag in tags:
        info = image_info(reg, repo, tag)
        if not info:
            continue
        digest, created, children = info
        entry = images.setdefault(digest, {"tags": [], "created": created, "children": children})
        entry["tags"].append(tag)

    ordered = sorted(images.items(), key=lambda kv: kv[1]["created"], reverse=True)
    kept, old = ordered[:keep], ordered[keep:]
    protected = set()
    for digest, entry in kept:
        protected.add(digest)
        protected.update(entry["children"])

    print(f"{repo}: {len(ordered)} images, keeping {len(kept)}: " + ", ".join(",".join(e["tags"]) for _, e in kept))
    for digest, entry in old:
        label = ",".join(entry["tags"])
        if dry_run:
            print(f"  would delete {label} (built {entry['created'][:19]})")
            continue
        for target in [digest] + [c for c in entry["children"] if c not in protected]:
            try:
                reg.call(f"/v2/{repo}/manifests/{target}", method="DELETE")
            except urllib.error.HTTPError as err:
                if err.code != 404:
                    raise
        print(f"  deleted {label} (built {entry['created'][:19]})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--keep", type=int, default=5, help="newest images to keep per repository (default 5)")
    ap.add_argument("--dry-run", action="store_true", help="only list what would be deleted")
    ap.add_argument("repos", nargs="+", help="HOST/REPO, e.g. registry.example.com/anonyma/web")
    args = ap.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be at least 1")

    registries = {}
    for full in args.repos:
        host, _, repo = full.partition("/")
        if not repo:
            raise SystemExit(f"expected HOST/REPO, got {full}")
        reg = registries.setdefault(host, Registry(host))
        prune(reg, repo, args.keep, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
