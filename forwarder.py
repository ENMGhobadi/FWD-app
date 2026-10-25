#!/usr/bin/env python3
"""Chrome-impersonating upstream forwarder for mhr-cfw.

Same wire protocol as upstream_forwarder.js:

    POST /fwd   header: x-upstream-auth: AUTH_KEY
    body:  { u, m, h, b, ct, r }        b = base64 request body
    200:   { s, h, b }                  s = status, h = headers, b = base64 body
    200:   { e: "message" }             relay-level error

The difference is the last hop: requests are issued with curl_cffi's Chrome
impersonation, so the target sees a Chrome-like TLS/JA3/JA4 + HTTP/2
fingerprint instead of Node/OpenSSL + HTTP/1.1. This is what makes
Cloudflare/Akamai challenges behave like they do for a real browser.

Requires: curl_cffi >= 0.16  (pip install -r requirements.txt)
Env:
    AUTH_KEY        required, >= 32 chars
    HOST            default 127.0.0.1 (use 0.0.0.0 on Render)
    PORT            default 8787 (Render injects it)
    IMPERSONATE     default "chrome" (curl_cffi profile; empty = disabled)
    EGRESS_PROXY    optional authenticated HTTP/SOCKS proxy URL; controls target egress IP
    TIMEOUT_MS      default 25000
    MAX_BODY_BYTES  default 50 MB
    REDIRECT_LIMIT  default 5
    ALLOW_PRIVATE   1 = allow private targets (LOCAL TESTING ONLY)
"""

from __future__ import annotations

import base64
import hmac
import ipaddress
import json
import logging
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlsplit

from curl_cffi import requests as cffi_requests

AUTH_KEY = os.environ.get("AUTH_KEY", "")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
IMPERSONATE = os.environ.get("IMPERSONATE", "chrome").strip()
TIMEOUT_S = max(1.0, int(os.environ.get("TIMEOUT_MS", "25000")) / 1000.0)
MAX_BODY = int(os.environ.get("MAX_BODY_BYTES", str(50 * 1024 * 1024)))
MAX_REQ = int(os.environ.get("MAX_REQUEST_BYTES", str(50 * 1024 * 1024)))
REDIRECT_LIMIT = int(os.environ.get("REDIRECT_LIMIT", "5"))
ALLOW_PRIVATE = os.environ.get("ALLOW_PRIVATE", "").strip().lower() in ("1", "true", "yes", "on")
EGRESS_PROXY = os.environ.get("EGRESS_PROXY", "").strip()

if not AUTH_KEY or len(AUTH_KEY) < 32:
    print("FATAL: AUTH_KEY env var missing or shorter than 32 chars.", file=sys.stderr)
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("forwarder")

SKIP_HEADERS = {
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-connection",
    "proxy-authorization",
    "x-upstream-auth",
    "x-relay-hop",
    "x-fwd-hop",
    "accept-encoding",  # let curl_cffi use the impersonation profile's value
    "te",
    "trailer",
    "upgrade",
}

PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet")
PRIVATE_HOSTS = {"localhost", "::1", "::", "metadata", "metadata.google.internal"}

STATUS_PAGE = (
    "<!DOCTYPE html><html><head><title>Forwarder Active</title></head>"
    '<body style="font-family:sans-serif;max-width:600px;margin:40px auto">'
    "<h1>Forwarder <span style=\"color:#16a34a;font-weight:700\">Active</span></h1>"
    "<p>mhr-cfw upstream forwarder.</p>"
    "<p>mode: " + ("proxy egress" if EGRESS_PROXY else "direct egress") + "</p>"
    "</body></html>"
)

_thread_local = threading.local()


def get_session():
    session = getattr(_thread_local, "session", None)
    if session is None:
        kwargs = {}
        if IMPERSONATE:
            kwargs["impersonate"] = IMPERSONATE
        if EGRESS_PROXY:
            kwargs["proxy"] = EGRESS_PROXY
        session = cffi_requests.Session(**kwargs)
        _thread_local.session = session
    return session


class RelayError(Exception):
    pass


def error_text(exc: Exception) -> str:
    text = str(exc).strip()
    return text or exc.__class__.__name__


def assert_public(url: str) -> None:
    if ALLOW_PRIVATE:
        return

    parts = urlsplit(url)
    host = (parts.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise RelayError("empty host")
    if host in PRIVATE_HOSTS or any(host.endswith(suffix) for suffix in PRIVATE_SUFFIXES):
        raise RelayError("private host blocked")

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise RelayError("DNS resolution failed: " + error_text(exc))

    for info in infos:
        address = info[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not ip.is_global:
            raise RelayError("private address blocked")


def sanitize_headers(raw) -> dict:
    headers = {}
    if not isinstance(raw, dict):
        return headers

    for key, value in raw.items():
        lower = str(key).lower()
        if lower in SKIP_HEADERS or lower.startswith("x-relay-") or lower.startswith("x-fwd-"):
            continue
        if isinstance(value, list):
            value = ", ".join(str(item) for item in value)
        headers[str(key)] = str(value)
    return headers


def drop_credentials(headers: dict) -> dict:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in ("authorization", "cookie", "proxy-authorization")
    }


def strip_header(headers: dict, name: str) -> dict:
    return {key: value for key, value in headers.items() if key.lower() != name}


def is_redirect(status: int) -> bool:
    return status in (301, 302, 303, 307, 308)


def fetch(method: str, url: str, headers: dict, body: bytes | None, follow: bool):
    session = get_session()

    # A Session keeps a cookie jar. The browser (through the local proxy) is
    # the only cookie authority, so never let one request's cookies leak into
    # the next one (or into another site).
    try:
        session.cookies.clear()
    except Exception:
        pass

    current = url
    current_method = method
    current_headers = dict(headers)
    current_body = body
    origin_host = (urlsplit(url).hostname or "").lower()

    for hop in range(REDIRECT_LIMIT + 1):
        assert_public(current)

        kwargs = {
            "headers": current_headers,
            "allow_redirects": False,
            "timeout": TIMEOUT_S,
        }
        if current_body is not None:
            kwargs["data"] = current_body
        elif current_method in ("POST", "PUT", "PATCH"):
            kwargs["data"] = b""

        response = session.request(current_method, current, **kwargs)

        if not follow or not is_redirect(response.status_code):
            return response

        location = response.headers.get("location")
        if not location:
            return response

        try:
            next_url = urljoin(current, location)
        except ValueError:
            return response
        if urlsplit(next_url).scheme not in ("http", "https"):
            return response
        if hop >= REDIRECT_LIMIT:
            raise RelayError("too many redirects")

        if (urlsplit(next_url).hostname or "").lower() != origin_host:
            current_headers = drop_credentials(current_headers)
        if response.status_code == 303 or (
            response.status_code in (301, 302)
            and current_method not in ("GET", "HEAD")
        ):
            current_method = "GET"
            current_body = None
            current_headers = strip_header(current_headers, "content-type")

        current = next_url

    raise RelayError("too many redirects")


def build_headers(response) -> dict:
    out = {}
    cookies = []
    for key, value in response.headers.multi_items():
        lower = key.lower()
        if lower in (
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "connection",
            "keep-alive",
            "te",
            "trailer",
            "upgrade",
        ):
            continue
        if lower == "set-cookie":
            cookies.append(value)
            continue
        out[key] = value

    if len(cookies) == 1:
        out["set-cookie"] = cookies[0]
    elif len(cookies) > 1:
        out["set-cookie"] = cookies

    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mhr-forwarder-py"

    def log_message(self, fmt, *args):  # keep the default quiet
        log.info("%s - %s", self.address_string(), fmt % args)

    def send_body(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_body(status, body, "application/json; charset=utf-8")

    @staticmethod
    def _path_only(path: str) -> str:
        return (urlsplit(path).path or "/").rstrip("/") or "/"

    def do_GET(self):
        if self._path_only(self.path) == "/":
            self.send_body(200, STATUS_PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        self.send_json(404, {"e": "not found"})

    def do_HEAD(self):
        # Render's health check may use HEAD; GET already skips the body for it.
        self.do_GET()

    def do_POST(self):
        # Accept POST /, /fwd and /fwd/ so a missing or trailing "/fwd" in the
        # Worker's UPSTREAM_FORWARDER_URL cannot break the relay. Auth is still
        # required, so exposing "/" as an endpoint is safe.
        if self._path_only(self.path) not in ("/", "/fwd"):
            self.send_json(404, {"e": "not found"})
            return

        provided = self.headers.get("x-upstream-auth", "")
        if not hmac.compare_digest(provided, AUTH_KEY):
            self.send_json(401, {"e": "unauthorized"})
            return

        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self.send_json(400, {"e": "invalid content-length"})
            return
        if length < 0 or length > MAX_REQ:
            self.send_json(413, {"e": "request body too large"})
            return

        raw = self.rfile.read(length) if length else b""

        try:
            payload = json.loads(raw)
        except Exception:
            self.send_json(200, {"e": "invalid json"})
            return

        if not isinstance(payload, dict) or not isinstance(payload.get("u"), str):
            self.send_json(200, {"e": "bad url"})
            return

        target = payload["u"]
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https"):
            self.send_json(200, {"e": "bad url"})
            return

        method = str(payload.get("m") or "GET").upper()
        headers = sanitize_headers(payload.get("h"))
        follow = payload.get("r") is not False

        body = None
        if payload.get("b"):
            try:
                body = base64.b64decode(payload["b"], validate=False)
            except Exception:
                self.send_json(200, {"e": "invalid base64 body"})
                return
            if len(body) > MAX_REQ:
                self.send_json(200, {"e": "request body too large"})
                return

        try:
            response = fetch(method, target, headers, body, follow)
            content = response.content
            if len(content) > MAX_BODY:
                raise RelayError("response body too large")

            encoded = base64.b64encode(content).decode("ascii")
            log.info("%s %s -> %s (%d bytes)", method, target[:100], response.status_code, len(content))
            self.send_json(200, {"s": response.status_code, "h": build_headers(response), "b": encoded})
        except Exception as exc:
            log.warning("%s %s -> %s", method, target[:100], error_text(exc))
            self.send_json(200, {"e": error_text(exc)})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    server = Server((HOST, PORT), Handler)
    log.info(
        "listening on %s:%d (profile=%s, timeout=%.1fs)",
        HOST,
        PORT,
        IMPERSONATE or "none",
        TIMEOUT_S,
    )
    if ALLOW_PRIVATE:
        log.warning("ALLOW_PRIVATE=1 - SSRF protection is disabled")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
