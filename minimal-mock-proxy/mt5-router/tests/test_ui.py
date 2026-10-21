import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from router import Config
from ui_state import RunControl, Mailbox, save_settings, load_settings
import app


class UiTests(unittest.TestCase):
    def test_cli_login_waits_until_ready_without_losing_saved_settings(self):
        with patch.object(sys, "argv", ["app.py", "--start", "--wait-proxy-until-ready", "--proxy-port", "8002"]), \
             patch("app.load_settings", return_value=Config(direct_ips=("203.0.113.1",))), \
             patch("app.gui") as window:
            self.assertEqual(app.main(), 0)
        self.assertEqual(window.call_args.args[0].direct_ips, ("203.0.113.1",))
        self.assertEqual(window.call_args.kwargs, {"auto_start": True, "proxy_wait": None})

    def test_cli_start_preserves_saved_direct_ips_and_applies_proxy_wait(self):
        with patch.object(sys, "argv", ["app.py", "--start", "--wait-proxy", "120", "--proxy-port", "8002"]), \
             patch("app.load_settings", return_value=Config(direct_ips=("203.0.113.1",))), \
             patch("app.gui") as window:
            self.assertEqual(app.main(), 0)
        defaults = window.call_args.args[0]
        self.assertEqual(defaults.proxy_port, 8002)
        self.assertEqual(defaults.direct_ips, ("203.0.113.1",))
        self.assertEqual(window.call_args.kwargs, {"auto_start": True, "proxy_wait": 120})

    def test_stop_while_event_is_being_created_is_not_lost(self):
        control = RunControl()
        ready, release = threading.Event(), threading.Event()
        real_event = asyncio.Event
        result = []
        def factory():
            ready.set()
            release.wait(2)
            return real_event()
        async def run():
            result.append(control.bind().is_set())
        def worker():
            asyncio.run(run())
        with patch("ui_state.asyncio.Event", factory):
            thread = threading.Thread(target=worker)
            thread.start()
            self.assertTrue(ready.wait(2))
            control.request_stop()
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [True])

    def test_log_burst_is_bounded_and_does_not_hide_failure(self):
        box = Mailbox(max_logs=10)
        for i in range(10000):
            box.log(str(i))
        box.event("failed", "driver startup failed")
        events, logs = box.drain(limit=3)
        self.assertEqual(events, [("failed", "driver startup failed")])
        self.assertEqual(len(logs), 4)  # Drop notice plus at most three log lines.
        self.assertLessEqual(box.logs.qsize(), 10)
        self.assertIn("9990 log messages omitted", logs[0])

    def test_settings_roundtrip_is_validated_and_does_not_persist_pid(self):
        with tempfile.TemporaryDirectory(prefix="mt5-router-settings-test-") as directory:
            path = Path(directory)
            self.assertEqual(path.resolve().parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(path.name.startswith("mt5-router-settings-test-"))
            file = path / "settings.json"
            self.assertEqual(load_settings(file), Config())
            config = Config(proxy_port=9000, process="other.exe", pid=424242, direct_ips=("2001:0db8::1",))
            save_settings(config, file)
            self.assertNotIn("pid", json.loads(file.read_text()))
            restored = load_settings(file)
            self.assertEqual(restored.proxy_port, 9000)
            self.assertEqual(restored.direct_ips, ("2001:db8::1",))
            self.assertIsNone(restored.pid)
            file.write_text('{"proxy_host":"0.0.0.0"}')
            with self.assertRaises(ValueError):
                load_settings(file)
            self.assertEqual(list(path.iterdir()), [file])

    def test_gui_preserves_failed_status_after_worker_cleanup(self):
        variables, buttons, queued, output = [], {}, [], []
        class Widget:
            def __init__(self, *a, **kw):
                if kw.get("text") in ("Start", "Stop"):
                    buttons[kw["text"]] = kw["command"]
            def __getattr__(self, name):
                if name == "index": return lambda *a: "1.0"
                if name == "insert": return lambda *a: output.append(a[-1])
                return lambda *a, **kw: None
        class Variable:
            def __init__(self, value): self.value = value; variables.append(self)
            def get(self): return self.value
            def set(self, value): self.value = value
        class Root(Widget):
            def after(self, delay, callback): queued.append(callback)
            def mainloop(self):
                buttons["Start"]()
                for worker in threading.enumerate():
                    if worker.name == "mt5-router": worker.join(2)
                queued.pop(0)()
        async def fail(self, stop): raise ConnectionRefusedError("test proxy unavailable")
        tk = types.ModuleType("tkinter")
        tk.Tk, tk.StringVar, tk.Text = Root, Variable, Widget
        tk.ttk = types.SimpleNamespace(Frame=Widget, Label=Widget, Entry=Widget, Button=Widget)
        tk.messagebox = types.SimpleNamespace(showerror=lambda *a, **kw: None)
        with patch.dict(sys.modules, {"tkinter": tk}), patch("app.diagnostics", return_value={}), \
             patch("app.processes", return_value=[]), patch("app.save_settings"), \
             patch("app.native_backend.ensure_supported"), patch("app.Router.run", fail):
            app.gui(Config())
        self.assertEqual(variables[4].value, "Failed - see log")
        self.assertIn("ConnectionRefusedError", "".join(output))


if __name__ == "__main__": unittest.main()
