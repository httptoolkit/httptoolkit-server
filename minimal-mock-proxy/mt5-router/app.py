"""MT5 Router's small Windows Start/Stop window and diagnostic CLI."""
import argparse
import asyncio
import importlib.metadata
import json
import logging
from logging.handlers import RotatingFileHandler
import math
from pathlib import Path
import signal
import sys
import threading
from dataclasses import replace

from router import Config, Router, processes, selected_pids
import native_backend
from ui_state import RunControl, Mailbox, load_settings, save_settings


def diagnostics(config):
    import mitmproxy_windows
    import mitmproxy_rs
    backend = native_backend.executable_path()
    required = [backend, backend.parent / "WinDivert.dll", backend.parent / "WinDivert64.sys"]
    if any(not p.is_file() for p in required):
        raise RuntimeError("Missing Windows interception files. Extract the whole portable folder.")
    return {"backend_version": importlib.metadata.version("mitmproxy-rs"),
            "backend": str(backend), "proxy": f"{config.proxy_host}:{config.proxy_port}",
            "target": config.process, "pids": selected_pids(config, processes()),
            "ports": [80, 443], "driver_started": False, "policy_version": 1,
            "native_architecture": native_backend.native_architecture(),
            "capture_supported": native_backend.native_architecture() == "x64"}


def gui(defaults, check=False, auto_start=False, proxy_wait=0):
    import tkinter as tk
    from tkinter import ttk, messagebox
    root = tk.Tk()
    if check:
        root.withdraw()
    root.title("MT5 Router")
    root.geometry("710x450")
    root.minsize(610, 360)
    frame = ttk.Frame(root, padding=14)
    frame.pack(fill="both", expand=True)
    process = tk.StringVar(value=defaults.process)
    host = tk.StringVar(value=defaults.proxy_host)
    port = tk.StringVar(value=str(defaults.proxy_port))
    direct = tk.StringVar(value=", ".join(defaults.direct_ips))
    rows = [("MT5 executable", process), ("Proxy IP", host), ("Proxy port", port),
            ("Direct IPs (optional)", direct)]
    inputs = []
    for row, (label, value) in enumerate(rows):
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=4)
        entry = ttk.Entry(frame, textvariable=value)
        entry.grid(row=row, column=1, sticky="ew", pady=4)
        inputs.append(entry)
    frame.columnconfigure(1, weight=1)
    ttk.Label(frame, text="TCP 80 / 443 → mock proxy. Start the proxy first; disable its Proxifier rule.",
              wraplength=650).grid(row=4, column=0, columnspan=2, sticky="w", pady=(10, 4))
    status = tk.StringVar(value="Stopped")
    ttk.Label(frame, textvariable=status).grid(row=5, column=0, sticky="w")
    controls = ttk.Frame(frame)
    controls.grid(row=5, column=1, sticky="e", pady=6)
    output = tk.Text(frame, height=12, state="disabled", wrap="word", font=("Consolas", 9))
    output.grid(row=6, column=0, columnspan=2, sticky="nsew")
    frame.rowconfigure(6, weight=1)
    messages = Mailbox()

    class Handler(logging.Handler):
        def emit(self, record):
            messages.log(self.format(record))

    handler = Handler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
    logging.getLogger().addHandler(handler)
    worker = None
    control = None
    closing = False
    active = False
    failed = False

    def stop():
        status.set("Stopping…")
        stop_button.configure(state="disabled")
        # Capture variables: startup can still be waiting for UAC.
        if control is not None:
            control.request_stop()

    def start():
        nonlocal worker, control, active, failed
        try:
            config = Config(host.get().strip(), int(port.get()), process.get().strip(), defaults.pid,
                            tuple(x.strip() for x in direct.get().split(",") if x.strip()))
            diagnostics(config)
            if not check:
                try:
                    save_settings(config)
                except OSError as e:
                    messages.log(f"Could not save settings: {type(e).__name__}")
            native_backend.ensure_supported()
            if any(name.casefold() == "proxifier.exe" for _, name in processes()):
                logging.warning("Proxifier is running. Disable its MT5 rule to prevent double routing.")
        except Exception as e:
            messagebox.showerror("Cannot start", str(e), parent=root)
            return
        control = RunControl()
        run_control = control
        active, failed = True, False
        start_button.configure(state="disabled")
        stop_button.configure(state="normal")
        for entry in inputs:
            entry.configure(state="disabled")
        status.set("Starting / waiting for administrator approval…")

        async def run():
            await Router(config, on_state=messages.event, proxy_wait=proxy_wait).run(run_control.bind())

        def work():
            try:
                asyncio.run(run())
            except Exception as e:
                messages.event("failed", f"{type(e).__name__}: {e}")
            else:
                messages.event("stopped")
        worker = threading.Thread(target=work, name="mt5-router", daemon=False)
        worker.start()

    start_button = ttk.Button(controls, text="Start", command=start)
    start_button.pack(side="left", padx=4)
    stop_button = ttk.Button(controls, text="Stop", command=stop, state="disabled")
    stop_button.pack(side="left")

    def poll():
        nonlocal active, failed
        events, logs = messages.drain(limit=100)
        for kind, message in events:
            if kind in ("stopped", "failed"):
                active = False
                failed = failed or kind == "failed"
                status.set("Failed - see log" if failed else "Stopped")
                if message:
                    logs.append(message)
                start_button.configure(state="normal")
                stop_button.configure(state="disabled")
                for entry in inputs:
                    entry.configure(state="normal")
                if closing:
                    root.destroy()
                    return
            elif kind in ("running", "stopping", "starting"):
                status.set(message)
        if logs:
            output.configure(state="normal")
            output.insert("end", "\n".join(logs) + "\n")
            lines = int(output.index("end-1c").split(".")[0])
            if lines > 500:
                output.delete("1.0", f"{lines - 499}.0")
            output.see("end")
            output.configure(state="disabled")
        root.after(100, poll)

    def close():
        nonlocal closing
        if active:
            closing = True
            stop()
        else:
            root.destroy()
    root.protocol("WM_DELETE_WINDOW", close)
    poll()
    if check:
        root.after(100, root.destroy)
    elif auto_start:
        root.after(100, start)
    root.mainloop()
    logging.getLogger().removeHandler(handler)


def main():
    parser = argparse.ArgumentParser(description="Route MT5 TCP ports 80/443 to minimal-mock-proxy.")
    parser.add_argument("--proxy-host")
    parser.add_argument("--proxy-port", type=int)
    parser.add_argument("--process", help="Exact executable basename")
    parser.add_argument("--pid", type=int, help="Only this PID, instead of executable name")
    parser.add_argument("--direct-ip", action="append", help="Keep this destination IP direct")
    parser.add_argument("--headless", action="store_true", help="Run until Ctrl+C (source CLI)")
    parser.add_argument("--start", action="store_true", help="Open the window and start capture automatically")
    proxy_wait = parser.add_mutually_exclusive_group()
    proxy_wait.add_argument("--wait-proxy", type=float, default=0, metavar="SECONDS", help="Wait up to 600 seconds for the CONNECT proxy before starting capture")
    proxy_wait.add_argument("--wait-proxy-until-ready", action="store_true", help="Wait for the CONNECT proxy until ready or Stop (login startup)")
    parser.add_argument("--check", action="store_true", help="Validate packaged files without starting capture")
    parser.add_argument("--check-ui", action="store_true", help="Construct and close the window without starting capture")
    parser.add_argument("--report", type=Path, help="Write --check JSON here (useful for windowed EXE)")
    parser.add_argument("--log-file", type=Path)
    args = parser.parse_args()
    if not math.isfinite(args.wait_proxy) or not 0 <= args.wait_proxy <= 600:
        parser.error("--wait-proxy must be between 0 and 600 seconds")
    if args.wait_proxy_until_ready:
        args.wait_proxy = None
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        handlers=[RotatingFileHandler(args.log_file, encoding="utf-8", maxBytes=2 * 1024 * 1024, backupCount=3)] if args.log_file else [])
    try:
        defaults = Config()
        if not (args.headless or args.check or args.check_ui):
            try:
                defaults = load_settings()
            except (ValueError, TypeError, OSError):
                logging.warning("Saved settings are invalid; using defaults.")
        supplied = {key: getattr(args, key) for key in ("proxy_host", "proxy_port", "process", "pid") if getattr(args, key) is not None}
        if args.direct_ip is not None:
            supplied["direct_ips"] = tuple(args.direct_ip)
        config = replace(defaults, **supplied)
        if args.check:
            result = diagnostics(config)
            text = json.dumps(result, indent=2)
            if args.report:
                args.report.write_text(text, encoding="utf-8")
            if sys.stdout is not None:
                print(text)
        elif args.check_ui:
            gui(config, check=True)
            if args.report:
                args.report.write_text(json.dumps({"gui_started": True, "driver_started": False}), encoding="utf-8")
        elif args.headless:
            if sys.stdout is not None:
                logging.getLogger().addHandler(logging.StreamHandler(sys.stdout))
            async def run():
                stop = asyncio.Event()
                loop = asyncio.get_running_loop()
                signal.signal(signal.SIGINT, lambda *_: loop.call_soon_threadsafe(stop.set))
                signal.signal(signal.SIGTERM, lambda *_: loop.call_soon_threadsafe(stop.set))
                await Router(config, proxy_wait=args.wait_proxy).run(stop)
            asyncio.run(run())
        else:
            gui(config, auto_start=args.start, proxy_wait=args.wait_proxy)
        return 0
    except Exception as e:
        text = f"{type(e).__name__}: {e}"
        logging.error(text)
        if args.report:
            args.report.write_text(json.dumps({"error": text}), encoding="utf-8")
        elif sys.stderr is not None:
            print(text, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
