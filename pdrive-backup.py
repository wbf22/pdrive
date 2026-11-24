#!/usr/bin/env python3
"""PDrive backup client — sync server files to a local directory.

Usage:
    ./pdrive-backup.py --server https://192.168.0.36:8080 --password mysecret \\
        --backup-dir ./pdrive_backup --ca-cert certs/pdrive-ca.crt
"""

import os
import sys
import json
import time
import base64
import uuid
import argparse
import ssl
import urllib.request
import urllib.error
import urllib.parse
import shutil

CHUNK_SIZE = 8192

SSL_CONTEXT = None


def main():
    global SSL_CONTEXT
    parser = argparse.ArgumentParser(description="PDrive Backup Client")
    parser.add_argument("--server", required=True, help="PDrive server URL (e.g. http://192.168.1.100:8080)")
    parser.add_argument("--password", required=True, help="Server password")
    parser.add_argument("--backup-dir", default="./pdrive_backup", help="Local backup directory (default: ./pdrive_backup)")
    parser.add_argument("--ca-cert", help="Path to the PDrive CA certificate to trust (for self-signed HTTPS)")
    parser.add_argument("--insecure", action="store_true", help="Skip TLS certificate verification (not recommended)")
    parser.add_argument("--yes", "-y", action="store_true", help="Upload locally-newer files without confirmation")
    args = parser.parse_args()

    if args.insecure:
        SSL_CONTEXT = ssl._create_unverified_context()
    elif args.ca_cert:
        SSL_CONTEXT = ssl.create_default_context(cafile=args.ca_cert)
    else:
        SSL_CONTEXT = ssl.create_default_context()

    server = args.server.rstrip("/")
    backup_dir = os.path.abspath(args.backup_dir)
    os.makedirs(backup_dir, exist_ok=True)

    # Authenticate
    print("Connecting to server...")
    try:
        token = _login(server, args.password)
    except Exception as e:
        print(f"Login failed: {e}", file=sys.stderr)
        sys.exit(1)
    print("  OK\n")

    # Build local manifest
    print("Scanning local backup...")
    manifest = _build_manifest(backup_dir)
    print(f"  {len(manifest)} files tracked\n")

    # Fetch the server's current file listing
    print("Syncing metadata with server...")
    try:
        server_files = _fetch_server_files(server, token)
    except Exception as e:
        print(f"Sync failed: {e}", file=sys.stderr)
        sys.exit(1)

    to_download, to_upload, deleted = _diff_manifests(manifest, server_files)
    print(f"  {len(to_download)} to download, {len(deleted)} to remove\n")

    # Upload locally-newer files (only with confirmation)
    if to_upload:
        _warn_newer(to_upload)
        if args.yes or _confirm(f"Upload {len(to_upload)} locally-newer file(s) to the server?"):
            print("Uploading files:")
            for entry in to_upload:
                _upload_file(server, token, entry["path"], backup_dir)
            print()
        else:
            print("  Skipped locally-newer files.\n")

    # Download modified/new files
    if to_download:
        print("Downloading files:")
        for entry in to_download:
            _download_file(server, token, entry["path"], entry["size"],
                           entry.get("mtime"), backup_dir)
        print()

    # Remove deleted files
    if deleted:
        print("Removing deleted files:")
        for path in deleted:
            _remove_local(backup_dir, path)
        print()

    if not to_download and not to_upload and not deleted:
        print("Already up to date!")
    else:
        print("Sync complete!")


def _login(server, password):
    req = urllib.request.Request(
        f"{server}/api/auth/login",
        data=json.dumps({"password": password}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=SSL_CONTEXT) as res:
        data = json.loads(res.read())
    return data["token"]


def _build_manifest(backup_dir):
    manifest = {}
    for root, _dirs, files in os.walk(backup_dir):
        for name in files:
            full = os.path.join(root, name)
            try:
                mtime = int(os.path.getmtime(full) * 1000)
            except OSError:
                continue
            rel = os.path.relpath(full, backup_dir)
            posix_path = "/" + rel.replace(os.sep, "/")
            manifest[posix_path] = mtime
    return manifest


def _sync(server, token, manifest):
    req = urllib.request.Request(
        f"{server}/api/files/sync",
        data=json.dumps({"files": manifest}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, context=SSL_CONTEXT) as res:
        data = json.loads(res.read())
    return data["modified"], data["deleted"]


def _fetch_server_files(server, token):
    modified, _deleted = _sync(server, token, {})
    return {e["path"]: {"mtime": e["mtime"], "size": e["size"]} for e in modified}


def _diff_manifests(client, server):
    to_download = []
    for path, info in server.items():
        client_mtime = client.get(path)
        if client_mtime is None or client_mtime < info["mtime"]:
            to_download.append({"path": path, "size": info["size"], "mtime": info["mtime"]})

    to_upload = []
    for path, client_mtime in client.items():
        info = server.get(path)
        if info is not None and client_mtime > info["mtime"]:
            to_upload.append({"path": path, "mtime": client_mtime})

    deleted = [p for p in client if p not in server]
    return to_download, to_upload, deleted


def _warn_newer(entries):
    yellow = "\033[33m"
    reset = "\033[0m"
    lines = [f"Warning: {len(entries)} local file(s) are newer than the server:"]
    lines += [f"  ! {e['path']}" for e in entries]
    print(f"{yellow}{chr(10).join(lines)}{reset}", file=sys.stderr)


def _confirm(prompt):
    try:
        reply = input(f"{prompt} [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return reply in ("y", "yes")


def _apply_mtime(path, mtime_ms):
    if mtime_ms is None:
        return
    try:
        ts = mtime_ms / 1000.0
        os.utime(path, (ts, ts))
    except OSError:
        pass


def _download_file(server, token, path, size, mtime, backup_dir):
    local_path = os.path.join(backup_dir, path.lstrip("/").replace("/", os.sep))
    os.makedirs(os.path.dirname(local_path), exist_ok=True)

    url = f"{server}/api/files/download?path={urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

    try:
        with urllib.request.urlopen(req, context=SSL_CONTEXT) as src:
            with open(local_path, "wb") as dst:
                total = 0
                last_pct = -1
                while True:
                    chunk = src.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    dst.write(chunk)
                    total += len(chunk)
                    if size > 0:
                        pct = total * 100 // size
                        if pct != last_pct:
                            last_pct = pct
                            _progress(f"  ↓ {path} ({pct}%)", pct < 100)
        if last_pct < 100:
            print(f"  ↓ {path}")
        _apply_mtime(local_path, mtime)
    except Exception as e:
        print(f"  ✗ {path} — {e}")


def _upload_file(server, token, path, backup_dir):
    local_path = os.path.join(backup_dir, path.lstrip("/").replace("/", os.sep))
    try:
        size = os.path.getsize(local_path)
        mtime_ms = int(os.path.getmtime(local_path) * 1000)
    except OSError as e:
        print(f"  ✗ {path} — {e}")
        return

    upload_id = str(uuid.uuid4())
    name_b64 = base64.b64encode(path.encode("utf-8")).decode("ascii")
    total_chunks = max(1, (size + CHUNK_SIZE - 1) // CHUNK_SIZE)

    try:
        with open(local_path, "rb") as f:
            last_pct = -1
            for i in range(total_chunks):
                chunk = f.read(CHUNK_SIZE)
                req = urllib.request.Request(
                    f"{server}/api/files/upload",
                    data=chunk,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "Authorization": f"Bearer {token}",
                        "X-Upload-Id": upload_id,
                        "X-Chunk-Index": str(i),
                        "X-Total-Chunks": str(total_chunks),
                        "X-File-Name": name_b64,
                        "X-File-Mtime": str(mtime_ms),
                    },
                )
                with urllib.request.urlopen(req, context=SSL_CONTEXT) as res:
                    json.loads(res.read())
                pct = (i + 1) * 100 // total_chunks
                if pct != last_pct:
                    last_pct = pct
                    _progress(f"  ↑ {path} ({pct}%)", pct < 100)
        if last_pct < 100:
            print(f"  ↑ {path}")
    except Exception as e:
        print(f"  ✗ {path} — {e}")


def _remove_local(backup_dir, path):
    local_path = os.path.join(backup_dir, path.lstrip("/").replace("/", os.sep))
    try:
        if os.path.isfile(local_path) or os.path.islink(local_path):
            os.remove(local_path)
            print(f"  ✕ {path}")
        elif os.path.isdir(local_path):
            shutil.rmtree(local_path)
            print(f"  ✕ {path}/")
    except OSError as e:
        print(f"  ✗ {path} — {e}")


def _progress(msg, inline):
    if inline:
        print(f"\r{msg}", end="", flush=True)
    else:
        print(f"\r{msg}")


if __name__ == "__main__":
    main()
