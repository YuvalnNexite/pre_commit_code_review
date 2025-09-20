"""Lightweight viewer for auto_code_review.md files with live updates."""
from __future__ import annotations

import json
import os
import queue
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Optional

from flask import Flask, Response, abort, jsonify, request

BASE_DIR = Path(__file__).resolve().parents[2]
STATIC_DIR = Path(__file__).resolve().parent / "static"
DEFAULT_POLL_INTERVAL = float(os.environ.get("REVIEW_VIEWER_POLL_INTERVAL", "1.0"))

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


@dataclass
class WatchPayload:
    """Container describing the state of the review file."""

    type: str
    exists: bool
    mtime_ns: Optional[int]

    def as_dict(self) -> Dict[str, Optional[str]]:
        return {
            "type": self.type,
            "exists": self.exists,
            "mtime": format_timestamp(self.mtime_ns),
        }


class ReviewWatcher:
    """Monitor a single review file for updates and notify subscribers."""

    def __init__(self, file_path: Path, interval: float = DEFAULT_POLL_INTERVAL) -> None:
        self._file_path = file_path
        self._interval = max(interval, 0.25)
        self._subscribers: set[queue.Queue[WatchPayload]] = set()
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._last_state = self._current_state()

        self._thread = threading.Thread(target=self._run, name=f"watch:{file_path}", daemon=True)
        self._thread.start()

    def subscribe(self) -> queue.Queue[WatchPayload]:
        subscriber: queue.Queue[WatchPayload] = queue.Queue()
        with self._lock:
            self._subscribers.add(subscriber)
        subscriber.put(WatchPayload("status", self._last_state is not None, self._last_state))
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue[WatchPayload]) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def stop(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=1.0)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            state = self._current_state()
            if state != self._last_state:
                self._last_state = state
                self._broadcast(WatchPayload("update", state is not None, state))
            self._stop_event.wait(self._interval)

    def _broadcast(self, payload: WatchPayload) -> None:
        with self._lock:
            subscribers: Iterable[queue.Queue[WatchPayload]] = tuple(self._subscribers)
        for subscriber in subscribers:
            subscriber.put(payload)

    def _current_state(self) -> Optional[int]:
        try:
            return self._file_path.stat().st_mtime_ns
        except FileNotFoundError:
            return None


_watchers: Dict[Path, ReviewWatcher] = {}
_watchers_lock = threading.Lock()


def get_watcher(file_path: Path) -> ReviewWatcher:
    resolved = file_path.resolve()
    with _watchers_lock:
        watcher = _watchers.get(resolved)
        if watcher is None:
            watcher = ReviewWatcher(resolved)
            _watchers[resolved] = watcher
        return watcher


def is_within_base(path: Path) -> bool:
    try:
        path.relative_to(BASE_DIR)
    except ValueError:
        return False
    return True


def resolve_review_file(raw_directory: Optional[str]) -> Path:
    directory = (BASE_DIR / (raw_directory or ".")).resolve()
    if not is_within_base(directory):
        abort(400, description="Directory is outside the project root.")
    if not directory.is_dir():
        abort(404, description="Directory not found.")
    return directory / "auto_code_review.md"


def relative_directory(path: Path) -> str:
    try:
        rel = path.relative_to(BASE_DIR)
    except ValueError:
        return str(path)
    return str(rel) if str(rel) else "."


def format_timestamp(mtime_ns: Optional[int]) -> Optional[str]:
    if mtime_ns is None:
        return None
    seconds = mtime_ns / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


@app.route("/")
def index() -> Response:
    return app.send_static_file("index.html")


@app.get("/api/review")
def api_review() -> Response:
    review_file = resolve_review_file(request.args.get("dir"))
    if not review_file.exists():
        abort(404, description="auto_code_review.md not found in the selected directory.")
    content = review_file.read_text(encoding="utf-8", errors="replace")
    return jsonify(
        {
            "directory": relative_directory(review_file.parent),
            "content": content,
        }
    )


@app.get("/stream")
def stream_updates() -> Response:
    review_file = resolve_review_file(request.args.get("dir"))
    watcher = get_watcher(review_file)
    subscriber = watcher.subscribe()

    def generate() -> Iterable[str]:
        try:
            while True:
                try:
                    payload = subscriber.get(timeout=15)
                except queue.Empty:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {json.dumps(payload.as_dict())}\n\n"
        finally:
            watcher.unsubscribe(subscriber)

    response = Response(generate(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.errorhandler(400)
def handle_bad_request(error):
    description = getattr(error, "description", "Bad request")
    if request.path.startswith("/api/"):
        return jsonify({"error": description}), 400
    return description, 400


@app.errorhandler(404)
def handle_not_found(error):
    description = getattr(error, "description", "Not found")
    if request.path.startswith("/api/"):
        return jsonify({"error": description}), 404
    return description, 404


if __name__ == "__main__":
    host = os.environ.get("REVIEW_VIEWER_HOST", "0.0.0.0")
    port = int(os.environ.get("REVIEW_VIEWER_PORT", os.environ.get("PORT", "5000")))
    app.run(host=host, port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
