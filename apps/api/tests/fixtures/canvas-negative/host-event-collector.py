"""Temporary RC-05 key-event collector bound only to the VPS Docker bridge."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Condition
from urllib.parse import urlsplit
import json
import time


events = []
changed = Condition()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            self.send_json({"ready": True})
        elif path == "/events":
            with changed:
                self.send_json(list(events))
        elif path == "/wait-first-up":
            with changed:
                found = changed.wait_for(
                    lambda: any(
                        event.get("mode") == "cancel"
                        and event.get("phase") == "up"
                        and event.get("key") == "ArrowUp"
                        for event in events
                    ),
                    timeout=15,
                )
                self.send_json({"observed": found, "events": list(events)})
        else:
            self.send_json({"error": "not_found"}, 404)

    def do_POST(self):
        if urlsplit(self.path).path != "/event":
            self.send_json({"error": "not_found"}, 404)
            return
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if not isinstance(data, dict):
                raise ValueError("event_not_object")
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "invalid_event"}, 400)
            return
        with changed:
            events.append({
                "mode": data.get("mode"),
                "phase": data.get("phase"),
                "key": data.get("key"),
                "at": data.get("at"),
                "receivedAt": int(time.time() * 1000),
            })
            changed.notify_all()
        self.send_json({"stored": True})


ThreadingHTTPServer(("172.17.0.1", 28055), Handler).serve_forever()
