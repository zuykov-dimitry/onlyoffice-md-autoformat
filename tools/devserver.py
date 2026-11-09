#!/usr/bin/env python3
"""
Dev server for testing the plugin in ONLYOFFICE web editors.

Serves the plugin folder with CORS headers so that the editor can load it:

    python3 tools/devserver.py [port]     # default 8484

Then in the ONLYOFFICE editor open DevTools -> Console, pick "frameEditor"
in the context drop-down (top of the console) and run:

    Asc.editor.installDeveloperPlugin("http://<this-host>:8484/config.json");

The plugin appears in the "Plugins" tab. Re-run the command after a page
reload (developer plugins are session-scoped).
"""

import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8484
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin")
V1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdk-v1")


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.abspath(ROOT), **kwargs)

    def translate_path(self, path):
        # serve the local SDK copy at /v1/ so the relative ../v1/plugins.js
        # reference resolves without leaving localhost
        if path.startswith("/v1/"):
            name = os.path.basename(path)
            return os.path.join(V1, name)
        return super().translate_path(path)

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), CorsHandler)
    print(f"Serving {os.path.abspath(ROOT)}")
    print(f"Plugin config: http://localhost:{PORT}/config.json")
    print("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
