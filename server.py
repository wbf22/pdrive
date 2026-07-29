#!/usr/bin/env python3
"""PDrive Python Backend — zero-dependency file server.

Usage:
    export PDRIVE_PASSWORD=mysecret
    python server.py [--port 8080] [--root /path/to/serve]

Then open the frontend (on GitHub Pages or locally) and point it
at http://<host>:8080.
"""
import os
import sys
import json
import time
import secrets
import hashlib
import hmac
import base64
import shutil
import mimetypes
import argparse
import urllib.parse
import http.server
import socketserver
import pathlib
import re

# ── Config ──────────────────────────────────────────────────────────
PASSWORD = os.environ.get("PDRIVE_PASSWORD", "")
PORT = int(os.environ.get("PDRIVE_PORT", "8080"))
ROOT = os.environ.get("PDRIVE_ROOT", os.getcwd())

# ── In-memory state ────────────────────────────────────────────────
TOKENS: dict[str, float] = {}          # token -> expiry timestamp
UPLOADS: dict[str, dict] = {}           # upload_id -> metadata
UPLOAD_DIR = os.path.join(
    os.path.expanduser("~"), ".pdrive", "uploads"
)
SERVER_SECRET = secrets.token_hex(32)
TOKEN_TTL = 86400 * 7  # 7 days


def now():
    return time.time()


# ── Token helpers ───────────────────────────────────────────────────
def make_token() -> str:
    token = secrets.token_hex(32)
    TOKENS[token] = now() + TOKEN_TTL
    return token


def validate_token(token: str) -> bool:
    exp = TOKENS.get(token)
    if exp is None:
        return False
    if now() > exp:
        del TOKENS[token]
        return False
    return True


def cleanup_tokens():
    stale = [t for t, e in TOKENS.items() if now() > e]
    for t in stale:
        del TOKENS[t]


# ── File helpers ────────────────────────────────────────────────────
def safe_path(user_path: str) -> str:
    """Resolve a user-supplied path relative to ROOT, preventing escapes."""
    if not user_path or user_path == "/":
        return ROOT
    cleaned = user_path.lstrip("/\\")
    resolved = os.path.normpath(os.path.join(ROOT, cleaned))
    if not resolved.startswith(os.path.normpath(ROOT)):
        return ROOT
    return resolved


def list_directory(dir_path: str) -> list[dict]:
    entries = []
    try:
        for name in os.listdir(dir_path):
            full = os.path.join(dir_path, name)
            try:
                st = os.stat(full)
                is_dir = os.path.isdir(full)
                rel = os.path.relpath(full, ROOT)
                posix_path = "/" + rel.replace(os.sep, "/") if rel != "." else "/"
                entries.append({
                    "name": name,
                    "isDirectory": is_dir,
                    "size": st.st_size,
                    "mtime": st.st_mtime * 1000,
                    "path": posix_path,
                })
            except OSError:
                continue
    except OSError:
        pass
    entries.sort(key=lambda e: (not e["isDirectory"], e["name"].lower()))
    return entries


MIME_GUESS = mimetypes.MimeTypes()
TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts",
             ".html", ".css", ".xml", ".yaml", ".yml", ".toml",
             ".ini", ".cfg", ".sh", ".bat", ".ps1", ".log", ".env",
             ".jsx", ".tsx", ".vue", ".svelte", ".rs", ".go", ".java",
             ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".lua", ".r",
             ".sql", ".swift", ".kt", ".scala", ".dart", ".zig"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"}


def guess_type(path: str) -> tuple[str, str]:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTS:
        mime = MIME_GUESS.guess_type(path)[0] or "application/octet-stream"
        return ("image", mime)
    if ext in TEXT_EXTS:
        return ("text", "text/plain; charset=utf-8")
    return ("binary", "application/octet-stream")


# ── Upload helpers ──────────────────────────────────────────────────
def ensure_upload_dir():
    os.makedirs(UPLOAD_DIR, exist_ok=True)


def handle_upload_chunk(headers, body: bytes) -> dict:
    upload_id = headers.get("x-upload-id", "")
    chunk_index_str = headers.get("x-chunk-index", "0")
    total_chunks_str = headers.get("x-total-chunks", "1")
    file_name_b64 = headers.get("x-file-name", "")

    if not upload_id or not file_name_b64:
        return {"error": "Missing upload headers"}, 400

    try:
        file_name = base64.b64decode(file_name_b64).decode("utf-8")
    except Exception:
        return {"error": "Invalid X-File-Name encoding"}, 400

    try:
        chunk_index = int(chunk_index_str)
        total_chunks = int(total_chunks_str)
    except ValueError:
        return {"error": "Invalid chunk index"}, 400

    ensure_upload_dir()
    chunk_dir = os.path.join(UPLOAD_DIR, upload_id)
    os.makedirs(chunk_dir, exist_ok=True)

    chunk_path = os.path.join(chunk_dir, f"chunk_{chunk_index:06d}")
    with open(chunk_path, "wb") as f:
        f.write(body)

    UPLOADS[upload_id] = {
        "file_name": file_name,
        "total_chunks": total_chunks,
        "received": len(os.listdir(chunk_dir)),
        "chunk_dir": chunk_dir,
    }

    if chunk_index == total_chunks - 1:
        return _finalize_upload(upload_id)

    return {"success": True, "uploadId": upload_id,
            "chunkIndex": chunk_index, "received": UPLOADS[upload_id]["received"]}, 200


def _finalize_upload(upload_id: str) -> dict:
    meta = UPLOADS.get(upload_id)
    if not meta:
        return {"error": "Upload not found"}, 404

    chunk_dir = meta["chunk_dir"]
    file_name = meta["file_name"]
    target = safe_path(file_name)

    os.makedirs(os.path.dirname(target), exist_ok=True)

    with open(target, "wb") as out:
        for i in range(meta["total_chunks"]):
            cp = os.path.join(chunk_dir, f"chunk_{i:06d}")
            if not os.path.exists(cp):
                shutil.rmtree(chunk_dir, ignore_errors=True)
                del UPLOADS[upload_id]
                return {"error": f"Missing chunk {i}"}, 400
            with open(cp, "rb") as cf:
                shutil.copyfileobj(cf, out)

    shutil.rmtree(chunk_dir, ignore_errors=True)
    del UPLOADS[upload_id]

    rel = os.path.relpath(target, ROOT)
    posix_path = "/" + rel.replace(os.sep, "/") if rel != "." else "/"
    return {"success": True, "path": posix_path}, 200


# ── HTTP Handler ────────────────────────────────────────────────────
class PDriveHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        sys.stderr.write("[PDrive] %s - %s\n" % (self.client_address[0], fmt % args))

    # -- CORS headers -------------------------------------------------
    def _cors_headers(self):
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, "
                                            "X-File-Name, X-Upload-Id, "
                                            "X-Chunk-Index, X-Total-Chunks",
            "Access-Control-Max-Age": "86400",
        }

    def _send_json(self, code: int, data):
        body = json.dumps(data).encode("utf-8")
        headers = self._cors_headers()
        headers["Content-Type"] = "application/json; charset=utf-8"
        headers["Content-Length"] = str(len(body))
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, code: int, msg: str):
        self._send_json(code, {"success": False, "error": msg})

    def _send_binary(self, code: int, data: bytes, content_type: str,
                     extra_headers: dict = None):
        headers = self._cors_headers()
        headers["Content-Type"] = content_type
        headers["Content-Length"] = str(len(data))
        if extra_headers:
            headers.update(extra_headers)
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return b""
        return self.rfile.read(length)

    def _parse_json_body(self) -> dict:
        body = self._read_body()
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    # -- Auth ---------------------------------------------------------
    def _check_auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        token = auth[len("Bearer "):]
        return validate_token(token)

    def _require_auth(self) -> bool:
        if not self._check_auth():
            self._send_error(401, "Unauthorized — provide a valid token")
            return False
        return True

    # -- Routing ------------------------------------------------------
    def do_OPTIONS(self):
        headers = self._cors_headers()
        self.send_response(204)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            return self._handle_health()
        if path == "/api/files/download":
            return self._handle_download(parsed.query)

        self._send_error(404, "Not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/auth/login":
            return self._handle_login()
        if not self._require_auth():
            return
        if path == "/api/files/list":
            return self._handle_list()
        if path == "/api/files/read":
            return self._handle_read()
        if path == "/api/files/write":
            return self._handle_write()
        if path == "/api/files/mkdir":
            return self._handle_mkdir()
        if path == "/api/files/delete":
            return self._handle_delete()
        if path == "/api/files/move":
            return self._handle_move()
        if path == "/api/files/upload":
            return self._handle_upload()

        self._send_error(404, "Not found")

    # -- Handlers -----------------------------------------------------
    def _handle_health(self):
        self._send_json(200, {"status": "ok", "server": "pdrive"})

    def _handle_login(self):
        body = self._parse_json_body()
        password = body.get("password", "")
        if not PASSWORD:
            self._send_error(403, "Server has no password configured")
            return
        if not hmac.compare_digest(password, PASSWORD):
            self._send_error(401, "Invalid password")
            return
        token = make_token()
        self._send_json(200, {"success": True, "token": token,
                              "expiresIn": TOKEN_TTL})

    def _handle_list(self):
        body = self._parse_json_body()
        dir_path = safe_path(body.get("path", "/"))
        entries = list_directory(dir_path)
        rel = os.path.relpath(dir_path, ROOT)
        posix_path = "/" + rel.replace(os.sep, "/") if rel != "." else "/"
        self._send_json(200, {"path": posix_path, "files": entries})

    def _handle_read(self):
        body = self._parse_json_body()
        file_path = body.get("path", "")
        if not file_path:
            return self._send_error(400, "Path required")
        abs_path = safe_path(file_path)
        if not os.path.isfile(abs_path):
            return self._send_error(404, "File not found")

        file_type, mime = guess_type(abs_path)
        if file_type == "image":
            with open(abs_path, "rb") as f:
                raw = f.read()
            b64 = base64.b64encode(raw).decode("ascii")
            self._send_json(200, {
                "path": file_path,
                "type": "image",
                "mime": mime,
                "content": b64,
            })
        elif file_type == "text":
            try:
                with open(abs_path, "r", encoding="utf-8") as f:
                    content = f.read()
            except UnicodeDecodeError:
                with open(abs_path, "rb") as f:
                    raw = f.read()
                b64 = base64.b64encode(raw).decode("ascii")
                self._send_json(200, {
                    "path": file_path,
                    "type": "binary",
                    "mime": "application/octet-stream",
                    "content": b64,
                })
                return
            self._send_json(200, {
                "path": file_path,
                "type": "text",
                "content": content,
            })
        else:
            with open(abs_path, "rb") as f:
                raw = f.read()
            b64 = base64.b64encode(raw).decode("ascii")
            self._send_json(200, {
                "path": file_path,
                "type": "binary",
                "mime": mime,
                "content": b64,
            })

    def _handle_write(self):
        body = self._parse_json_body()
        file_path = body.get("path", "")
        content = body.get("content", "")
        if not file_path:
            return self._send_error(400, "Path required")
        abs_path = safe_path(file_path)
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(content)
        self._send_json(200, {"success": True, "path": file_path})

    def _handle_mkdir(self):
        body = self._parse_json_body()
        dir_path = body.get("path", "")
        if not dir_path:
            return self._send_error(400, "Path required")
        abs_path = safe_path(dir_path)
        os.makedirs(abs_path, exist_ok=True)
        self._send_json(200, {"success": True, "path": dir_path})

    def _handle_delete(self):
        body = self._parse_json_body()
        target = body.get("path", "")
        is_dir = body.get("isDirectory", False)
        if not target:
            return self._send_error(400, "Path required")
        abs_path = safe_path(target)
        if not os.path.exists(abs_path):
            return self._send_error(404, "Not found")
        if is_dir and os.path.isdir(abs_path):
            shutil.rmtree(abs_path)
        else:
            os.remove(abs_path)
        self._send_json(200, {"success": True})

    def _handle_move(self):
        body = self._parse_json_body()
        old = body.get("oldPath", "")
        new = body.get("newPath", "")
        if not old or not new:
            return self._send_error(400, "oldPath and newPath required")
        old_abs = safe_path(old)
        new_abs = safe_path(new)
        os.makedirs(os.path.dirname(new_abs), exist_ok=True)
        shutil.move(old_abs, new_abs)
        self._send_json(200, {"success": True, "oldPath": old, "newPath": new})

    def _handle_upload(self):
        ct = self.headers.get("Content-Type", "")

        # Chunked upload via raw binary + headers
        if ct == "application/octet-stream" or "x-upload-id" in self.headers:
            body = self._read_body()
            result, code = handle_upload_chunk(self.headers, body)
            self._send_json(code, result)
            return

        # Full-file upload via multipart form-data (legacy)
        body = self._read_body()
        boundary = None
        if "boundary=" in ct:
            boundary = ct.split("boundary=", 1)[1].strip()
        if boundary:
            file_data, file_name = _parse_multipart(body, boundary)
            if file_data:
                target = safe_path(file_name or "uploaded_file")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(file_data)
                rel = os.path.relpath(target, ROOT)
                posix_path = "/" + rel.replace(os.sep, "/") if rel != "." else "/"
                self._send_json(200, {"success": True, "path": posix_path})
                return

        self._send_error(400, "Upload failed — use multipart or chunked protocol")

    def _handle_download(self, query: str):
        params = urllib.parse.parse_qs(query)
        paths = params.get("path", [])
        if not paths:
            return self._send_error(400, "Path required")
        file_path = paths[0]
        abs_path = safe_path(file_path)
        if not os.path.isfile(abs_path):
            return self._send_error(404, "File not found")

        file_size = os.path.getsize(abs_path)
        mime, _ = mimetypes.guess_type(abs_path)
        if not mime:
            mime = "application/octet-stream"

        range_header = self.headers.get("Range", "")
        if range_header and range_header.startswith("bytes="):
            try:
                ranges = range_header[6:].split("-")
                start = int(ranges[0]) if ranges[0] else 0
                end = int(ranges[1]) if len(ranges) > 1 and ranges[1] else file_size - 1
                if start >= file_size:
                    self._send_error(416, "Range not satisfiable")
                    return
                length = end - start + 1
                with open(abs_path, "rb") as f:
                    f.seek(start)
                    data = f.read(length)
                self._send_binary(206, data, mime, {
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                })
            except (ValueError, IndexError):
                self._send_error(400, "Invalid Range header")
            return

        # Full file stream
        with open(abs_path, "rb") as f:
            data = f.read()
        self._send_binary(200, data, mime, {
            "Content-Disposition": f'inline; filename="{os.path.basename(abs_path)}"',
            "Accept-Ranges": "bytes",
        })


# ── Minimal multipart parser ────────────────────────────────────────
def _parse_multipart(body: bytes, boundary: str) -> tuple[bytes | None, str | None]:
    """Extract first file field from a multipart body."""
    boundary_bytes = boundary.encode("utf-8")
    parts = body.split(b"--" + boundary_bytes)
    for part in parts:
        if b"Content-Disposition" not in part:
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        raw_headers = part[:header_end].decode("utf-8", errors="replace")
        data = part[header_end + 4:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        file_name = None
        for line in raw_headers.split("\r\n"):
            if "name=" in line.lower() and "filename=" in line.lower():
                # extract filename
                m = re.search(r'filename="([^"]*)"', line)
                if m:
                    file_name = m.group(1)
        if file_name:
            return data, file_name
    return None, None


# ── Main ────────────────────────────────────────────────────────────
def main():
    global PASSWORD, PORT, ROOT

    parser = argparse.ArgumentParser(description="PDrive Python Backend")
    parser.add_argument("--port", type=int, default=None,
                        help=f"Port (default: {PORT}, env: PDRIVE_PORT)")
    parser.add_argument("--root", type=str, default=None,
                        help=f"Root directory (default: {ROOT}, env: PDRIVE_ROOT)")
    parser.add_argument("--password", type=str, default=None,
                        help="Auth password (env: PDRIVE_PASSWORD)")
    args = parser.parse_args()

    if args.password:
        PASSWORD = args.password
    if args.port:
        PORT = args.port
    if args.root:
        ROOT = os.path.abspath(args.root)

    if not PASSWORD:
        print("ERROR: PDRIVE_PASSWORD is not set.", file=sys.stderr)
        print("Set it via environment variable or --password flag.", file=sys.stderr)
        sys.exit(1)

    ROOT = os.path.abspath(ROOT)
    os.makedirs(ROOT, exist_ok=True)
    ensure_upload_dir()

    server = socketserver.TCPServer(("0.0.0.0", PORT), PDriveHandler)
    print(f" PDrive Backend running on http://0.0.0.0:{PORT}")
    print(f" Root: {ROOT}")
    print(f" Password: {'set' if PASSWORD else 'NOT SET!'}")
    print(f" Upload temp: {UPLOAD_DIR}")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
