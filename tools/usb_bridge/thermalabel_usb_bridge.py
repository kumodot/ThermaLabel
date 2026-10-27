"""
thermalabel_usb_bridge.py  v0.1.0

Local USB print bridge for ThermaLabel (Windows).

A web page can't reach the Windows print queue, so this tiny server listens on
127.0.0.1:5758 and passes ready-made printer jobs (TSPL for the MUNBYN 130B) from
ThermaLabel to a Windows printer queue as a RAW job. Nothing else: no install,
no background service. Run RUN_ThermaLabel_USB_Bridge_v0.1.0.bat while printing,
close the window when done.

Endpoints (CORS limited to ThermaLabel's origins):
  GET  /ping            -> {ok, version, printer, printers}
  POST /tspl[?printer=] -> body = raw job bytes (must start with "SIZE " and end with a PRINT command)

Safety: listens on 127.0.0.1 only; requests must come from an allowed Origin and carry the
X-ThermaLabel header (forces a CORS preflight a random site can't pass); body must look like TSPL.

Requires: Python 3.9+, pywin32 (pip install pywin32)
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import win32print
except ImportError:
    print("pywin32 is missing. Run:  pip install pywin32")
    input("Press Enter to close...")
    sys.exit(1)

VERSION = "0.1.0"
HOST, PORT = "127.0.0.1", 5758
ALLOWED_ORIGINS = {"https://kumodot.github.io", "null"}   # "null" = ThermaLabel opened from a local file
MAX_BYTES = 4 * 1024 * 1024
PRINTER_HINTS = ("munbyn", "itpp130", "130b")             # used to pick the default queue


def list_printers():
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    return [p[2] for p in win32print.EnumPrinters(flags)]


def default_printer():
    for name in list_printers():
        if any(h in name.lower() for h in PRINTER_HINTS):
            return name
    return None


def send_raw(data: bytes, printer_name: str, job_name: str = "ThermaLabel") -> int:
    h = win32print.OpenPrinter(printer_name)
    try:
        job_id = win32print.StartDocPrinter(h, 1, (job_name, None, "RAW"))
        try:
            win32print.StartPagePrinter(h)
            win32print.WritePrinter(h, data)
            win32print.EndPagePrinter(h)
        finally:
            win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)
    return job_id


class Handler(BaseHTTPRequestHandler):
    server_version = f"ThermaLabelUSBBridge/{VERSION}"

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-ThermaLabel")
            # Chrome's Private Network Access preflight (public https page -> localhost)
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path != "/ping":
            return self._json(404, {"error": "not found"})
        self._json(200, {"ok": True, "app": "ThermaLabel USB bridge", "version": VERSION,
                         "printer": default_printer(), "printers": list_printers()})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/tspl":
            return self._json(404, {"error": "not found"})
        if self.headers.get("Origin", "") not in ALLOWED_ORIGINS or self.headers.get("X-ThermaLabel") != "1":
            return self._json(403, {"error": "not allowed"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self._json(400, {"error": "empty or too large"})
        data = self.rfile.read(size)
        if not data.startswith(b"SIZE ") or b"PRINT " not in data[-64:]:
            return self._json(400, {"error": "not a TSPL job"})
        printer = (parse_qs(url.query).get("printer") or [None])[0] or default_printer()
        if not printer:
            return self._json(500, {"error": "no MUNBYN printer queue found in Windows", "printers": list_printers()})
        try:
            job_id = send_raw(data, printer)
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": str(e)})
        print(f"[PRINT] job {job_id}: {len(data)} bytes -> {printer}")
        self._json(200, {"ok": True, "job_id": job_id, "bytes": len(data), "printer": printer})

    def log_message(self, fmt, *args):  # keep the console quiet except for print jobs
        pass


def main():
    print(f"ThermaLabel USB bridge v{VERSION}")
    print(f"Listening on http://{HOST}:{PORT}  (close this window to stop)")
    p = default_printer()
    print(f"Printer queue: {p or 'NOT FOUND'}")
    if not p:
        print("Windows printers:", ", ".join(list_printers()) or "(none)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
