"""Thread-safe UI controls, bounded logs and per-user configuration storage."""
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import queue
import tempfile
import threading


class RunControl:
    def __init__(self):
        self.lock = threading.Lock()
        self.handles = None
        self.requested = False

    def bind(self):
        loop, stop = asyncio.get_running_loop(), asyncio.Event()
        with self.lock:
            self.handles = (loop, stop)
            if self.requested:
                stop.set()
        return stop

    def request_stop(self):
        with self.lock:
            self.requested = True
            handles = self.handles
        if handles is not None:
            loop, stop = handles
            try:
                loop.call_soon_threadsafe(stop.set)
            except RuntimeError:
                pass  # Worker has already closed its event loop.


class Mailbox:
    def __init__(self, max_logs=1000):
        self.logs = queue.Queue(maxsize=max_logs)
        self.events = queue.SimpleQueue()
        self.dropped = 0
        self.lock = threading.Lock()

    def log(self, message):
        try:
            self.logs.put_nowait(message)
        except queue.Full:
            with self.lock:
                self.dropped += 1

    def event(self, kind, message=""):
        self.events.put((kind, message))

    def drain(self, limit=100):
        events, logs = [], []
        # Lifecycle messages have priority over log bursts.
        while not self.events.empty():
            events.append(self.events.get_nowait())
        with self.lock:
            if self.dropped:
                logs.append(f"{self.dropped} log messages omitted to keep the window responsive.")
                self.dropped = 0
        for _ in range(limit):
            try:
                logs.append(self.logs.get_nowait())
            except queue.Empty:
                break
        return events, logs


def settings_path():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "MT5Router/settings.json"


def load_settings(path=None):
    from router import Config
    try:
        data = json.loads((path or settings_path()).read_text(encoding="utf-8"))
        allowed = {"process", "proxy_host", "proxy_port", "direct_ips"}
        if not isinstance(data, dict) or set(data) - allowed:
            raise ValueError("Invalid saved settings")
        return Config(**data)
    except FileNotFoundError:
        return Config()


def save_settings(config, path=None):
    path = path or settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {key: value for key, value in asdict(config).items()
            if key in {"process", "proxy_host", "proxy_port", "direct_ips"}}
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            name = Path(file.name)
            json.dump(data, file, indent=2)
        os.replace(name, path)
    finally:
        if name is not None:
            name.unlink(missing_ok=True)
