#!/usr/bin/env python3
"""Echo Dashboard server — standard library only.

Serves the static dashboard and keeps the Spotify client secret off the page:
the browser still talks to api.spotify.com directly, but the OAuth code exchange
and token refresh go through here so the secret never leaves this machine.
Tokens are not stored server-side; each browser keeps its own in localStorage.
"""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "public"
PORT = int(os.environ.get("PORT", "8766"))
CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get(
    "SPOTIFY_REDIRECT_URI", "https://ha.americanglasscorporation.com/local/dashboard.html"
)
WEATHER_LAT = os.environ.get("WEATHER_LAT") or None
WEATHER_LON = os.environ.get("WEATHER_LON") or None

# Paths the kiosk or Spotify's redirect may hit → file in public/
ROUTES = {
    "/": "dashboard.html",
    "/dashboard.html": "dashboard.html",
    "/local/dashboard.html": "dashboard.html",  # the redirect URI registered with Spotify
    "/app.js": "app.js",
}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8"}


def version():
    """Changes whenever a public file changes, so open kiosks reload themselves."""
    h = hashlib.sha1()
    for name in sorted(set(ROUTES.values())):
        h.update((ROOT / name).read_bytes())
    return h.hexdigest()[:12]


def spotify_token(form):
    creds = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode(form).encode(),
        headers={"Authorization": "Basic " + creds,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError as e:
        return 502, json.dumps({"error": "upstream", "detail": str(e)}).encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "EchoDashboard"

    def send(self, status, body, ctype="application/json", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ROUTES:
            f = ROOT / ROUTES[path]
            return self.send(200, f.read_bytes(), TYPES[f.suffix])
        if path == "/api/config":
            body = {"client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI, "version": version(),
                    "lat": float(WEATHER_LAT) if WEATHER_LAT else None,
                    "lon": float(WEATHER_LON) if WEATHER_LON else None}
            return self.send(200, json.dumps(body).encode())
        if path == "/healthz":
            return self.send(200, b"ok", "text/plain")
        self.send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 8192)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send(400, b'{"error":"bad json"}')
        if path == "/api/spotify/token" and isinstance(data.get("code"), str):
            status, body = spotify_token({"grant_type": "authorization_code",
                                          "code": data["code"], "redirect_uri": REDIRECT_URI})
            return self.send(status, body)
        if path == "/api/spotify/refresh" and isinstance(data.get("refresh_token"), str):
            status, body = spotify_token({"grant_type": "refresh_token",
                                          "refresh_token": data["refresh_token"]})
            return self.send(status, body)
        self.send(404, b'{"error":"not found"}')

    def log_message(self, fmt, *args):
        # Keep logs quiet: only errors and API calls, never query strings (OAuth codes).
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/spotify") or (args and str(args[1])[:1] in "45"):
            sys.stderr.write(f"{self.address_string()} {self.command} {path} {args[1] if len(args) > 1 else ''}\n")


if __name__ == "__main__":
    if not CLIENT_ID or not CLIENT_SECRET:
        sys.exit("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set (see .env.example)")
    print(f"Echo Dashboard on :{PORT}  redirect_uri={REDIRECT_URI}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
