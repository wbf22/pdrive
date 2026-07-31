#!/usr/bin/env python3
"""PDrive backup client — sync server files to a local directory.

Usage:
    ./pdrive-backup.py --server http://192.168.1.100:8080 --password mysecret \\
        --backup-dir ./pdrive_backup
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
import shutil

CHUNK_SIZE = 8192


def main():
    parser = argparse.ArgumentParser(description="PDrive Backup Client")
    parser.add_argument("--server", required=True, help="PDrive server URL (e.g. http://192.168.1.100:8080)")
    parser.add_argument("--password", required=True, help="Server password")
    parser.add_argument("--backup-dir", default="./pdrive_backup", help="Local backup directory (default: ./pdrive_backup)")
    args = parser.parse_args()

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

    # Sync with server
    print("Syncing metadata with server...")
    try:
        modified, deleted = _sync(server, token, manifest)
    except Exception as e:
        print(f"Sync failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(modified)} to download, {len(deleted)} to remove\n")

    # Download modified/new files
    if modified:
        print("Downloading files:")
        for entry in modified:
            _download_file(server, token, entry["path"], entry["size"], backup_dir)
        print()

    # Remove deleted files
    if deleted:
        print("Removing deleted files:")
        for path in deleted:
            _remove_local(backup_dir, path)
        print()

    if not modified and not deleted:
        print("Already up to date!")
    else:
        print("Sync complete!")


def _login(server, password):
    req = urllib.request.Request(
        f"{server}/api/auth/login",
        data=json.dumps({"password": password}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
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
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read())
    return data["modified"], data["deleted"]


def _download_file(server, token, path, size, backup_dir):
    local_path = os.path.join(backup_dir, path.lstrip("/").replace("/", os.sep))
    os.makedirs(os.path.dirname(local_path), exist_ok=True)

    url = f"{server}/api/files/download?path={urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

    try:
        with urllib.request.urlopen(req) as src:
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
