"""Adapter for the pinned, port-restricted Windows redirector build."""
import asyncio
import contextlib
import ctypes
from ctypes import wintypes
import json
import logging
import mmap
import os
from pathlib import Path
import sys
import uuid

COMMIT = "40f1dfb5dca7b03ff7793d3c90f23b8bdf873889"
LOG = logging.getLogger("mt5-router")


def executable_path():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "mt5_native" / "windows-redirector.exe"
    return Path(__file__).resolve().parent / "build/native" / f"mitmproxy_rs-{COMMIT}" / "target/x86_64-pc-windows-msvc/release/windows-redirector.exe"


def native_architecture():
    if sys.platform != "win32":
        return "unsupported"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    # On ARM64, GetNativeSystemInfo can report x64 to an emulated process.
    # IsWow64Process2's native-machine output identifies the real kernel.
    if hasattr(kernel, "IsWow64Process2"):
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.IsWow64Process2.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.WORD)]
        kernel.IsWow64Process2.restype = wintypes.BOOL
        process_machine, machine = wintypes.WORD(), wintypes.WORD()
        if not kernel.IsWow64Process2(kernel.GetCurrentProcess(), ctypes.byref(process_machine), ctypes.byref(machine)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {0x8664: "x64", 0xAA64: "arm64", 0x14C: "x86"}.get(machine.value, "unsupported")
    kernel.GetNativeSystemInfo.argtypes = [ctypes.c_void_p]
    kernel.GetNativeSystemInfo.restype = None
    data = ctypes.create_string_buffer(64)
    kernel.GetNativeSystemInfo(data)
    return {9: "x64", 12: "arm64", 0: "x86"}.get(ctypes.c_ushort.from_buffer(data).value, "unsupported")


def ensure_supported():
    arch = native_architecture()
    if arch != "x64":
        raise RuntimeError(f"This PC runs Windows {arch}. The bundled x64 WinDivert driver requires Intel/AMD x64 Windows; it cannot run on ARM64, including under x64 emulation.")


def encode_policy(config, ready_event):
    payload = {"version": 1, "process": config.process, "pid": config.pid,
               "exclude_pid": os.getpid(), "direct_ips": list(config.direct_ips), "ready_event": ready_event}
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode().hex()
    if len(encoded) > 16384:
        raise ValueError("Routing policy is too large.")
    return "MT5_ROUTER_V1:" + encoded


class KernelObject:
    """Parent-owned readiness event or a session-wide single-capture mutex."""
    def __init__(self, mutex=False):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.mutex = mutex
        self.handle = None
        self.name = "Local\\MT5RouterCapture-v1" if mutex else f"Local\\MT5RouterReady-{os.getpid():x}-{uuid.uuid4().hex}"
        if mutex:
            self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
            self.kernel.CreateMutexW.restype = wintypes.HANDLE
            self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            self.handle = self.kernel.CreateMutexW(None, False, self.name)
        else:
            self.kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
            self.kernel.CreateEventW.restype = wintypes.HANDLE
            self.handle = self.kernel.CreateEventW(None, True, False, self.name)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if mutex and self.kernel.WaitForSingleObject(self.handle, 0) not in (0, 128):
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            raise RuntimeError("Another MT5 Router capture is already running. Stop it first.")

    def signaled(self):
        result = self.kernel.WaitForSingleObject(self.handle, 0)
        if result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        return result == 0

    def close(self):
        if self.handle:
            if self.mutex:
                self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class ProcessMonitor:
    """The helper publishes its PID before connecting IPC or opening capture handles."""
    def __init__(self):
        self.mapping = mmap.mmap(-1, 4, tagname=f"Local\\MT5RouterPid-{os.getpid()}")
        self.mapping[:] = bytes(4)
        self.handle = None
        self.observed = False
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def observe(self):
        if self.observed:
            return
        pid = int.from_bytes(self.mapping[:], "little")
        if pid:
            self.handle = self.kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
            if not self.handle and ctypes.get_last_error() != 87:  # Already exited
                raise ctypes.WinError(ctypes.get_last_error())
            self.observed = True

    async def wait_exited(self):
        self.observe()
        while self.handle:
            result = self.kernel.WaitForSingleObject(self.handle, 0)
            if result == 0:
                return
            if result == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
            await asyncio.sleep(0.02)

    def unblock_ipc(self):
        # The pinned backend waits for the first pipe client outside its shutdown
        # select. Connect-and-close our own pipe so Stop also works before the
        # helper connects. An already connected helper makes this return BUSY.
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                           ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        handle = self.kernel.CreateFileW(r"\\.\pipe\mitmproxy-transparent-proxy-" + str(os.getpid()),
                                        0xC0000000, 0, None, 3, 0x40000000, None)
        if handle != ctypes.c_void_p(-1).value:
            self.kernel.CloseHandle(handle)
        elif ctypes.get_last_error() not in (2, 231):
            LOG.warning("Could not wake pending capture IPC: Windows error %s", ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
        self.mapping.close()


class Session:
    def __init__(self, backend, closed, lock, process):
        self.backend, self.closed, self.lock, self.process = backend, closed, lock, process
        self.shutdown = None

    async def close(self):
        if self.shutdown is None:
            self.shutdown = asyncio.create_task(self._close())
        # Cancellation must not release the capture lock ahead of native exit.
        cancelled = False
        while True:
            try:
                await asyncio.shield(self.shutdown)
                break
            except asyncio.CancelledError:
                if self.shutdown.cancelled():
                    raise
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError

    async def _close(self):
        with contextlib.suppress(Exception):
            self.backend.set_intercept("")
        self.backend.close()
        self.process.unblock_ipc()
        async def confirmed():
            await asyncio.shield(self.closed)
            await self.process.wait_exited()
        confirmation = asyncio.create_task(confirmed())
        done, _ = await asyncio.wait((confirmation,), timeout=5)
        if not done:
            LOG.warning("Shutdown is still pending; waiting for Windows capture to exit. Capture remains locked.")
        # Keep monitoring, including after the warning. Never turn timeout into success.
        await confirmation
        self.process.close()
        self.lock.close()


async def start(config, tcp_handler, udp_handler):
    import mitmproxy_rs
    import mitmproxy_windows
    ensure_supported()
    executable = executable_path()
    if any(not (executable.parent / name).is_file() for name in (executable.name, "WinDivert.dll", "WinDivert64.sys")):
        raise RuntimeError("Missing native helper files. Build the app or extract its entire portable folder.")
    lock, ready, process = KernelObject(mutex=True), None, None
    session = None
    complete = False
    old_path = mitmproxy_windows.executable_path
    try:
        ready = KernelObject()
        process = ProcessMonitor()
        # The pinned Python extension exposes the helper path through this function.
        # Keep its public IPC format; the native policy travels as one encoded action.
        mitmproxy_windows.executable_path = lambda: executable
        backend = await mitmproxy_rs.local.start_local_redirector(tcp_handler, udp_handler)
        session = Session(backend, asyncio.ensure_future(backend.wait_closed()), lock, process)
        backend.set_intercept(encode_policy(config, ready.name))
        while not ready.signaled():
            process.observe()
            if session.closed.done():
                await session.closed
                raise RuntimeError("Native capture exited before readiness. Check driver compatibility and administrator approval.")
            await asyncio.sleep(0.02)
        complete = True
        return session
    finally:
        mitmproxy_windows.executable_path = old_path
        if ready is not None:
            ready.close()
        if not complete:
            if session is not None:
                await session.close()
            else:
                if process is not None:
                    process.unblock_ipc()
                    process.close()
                lock.close()
