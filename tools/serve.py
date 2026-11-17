#!/usr/bin/env python3
"""A static server for a built norns-js, with the two headers it cannot run
without. Standard library only.

    python3 serve.py [dir] [port]      # defaults: ./app 8080

WHY THIS EXISTS BESIDE serve.mjs, which does the same job: SteamOS ships
Python and does not ship Node, and its root filesystem is immutable -- a
`pacman -S nodejs` does not survive a system update. Python is already
there, so on a Steam Deck this is the whole install.

WHY A SERVER AT ALL, since it is "just a web page": scsynth is compiled with
pthreads and needs SharedArrayBuffer, which a page only gets when it is
CROSS-ORIGIN ISOLATED, which is granted by two response headers:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

A file:// URL has no response headers at all, so nothing can grant it. No
isolation, no SharedArrayBuffer, no audio. `python3 -m http.server` does NOT
send them, which is exactly why this file is not that one line.

The root is the app and every folder below it LISTS, because the page offers
its own source at ./source/ (AGPL §13) and a folder with no index.html is a
404 on a server that only maps paths to files.
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "app")
PORT = int(sys.argv[2] if len(sys.argv) > 2 else 8080)

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
    ".data": "application/octet-stream",
    ".lua": "text/plain",
    ".sc": "text/plain",
}


class Handler(SimpleHTTPRequestHandler):
    # SimpleHTTPRequestHandler reads this class attribute, and guesses
    # text/plain for anything missing -- which for .wasm means a browser
    # that refuses to compile it.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is noise on a handheld with no scrollback.
        pass


def main():
    handler = partial(Handler, directory=ROOT)
    with ThreadingHTTPServer(("0.0.0.0", PORT), handler) as httpd:
        print(f"norns-js: serving {ROOT}")
        print(f"  http://localhost:{PORT}/")
        print("  cross-origin isolation headers are on; audio needs them.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
