import asyncio
import ctypes
import json
from pathlib import Path
import sys
import platform
import threading
import unittest
from unittest.mock import patch, Mock, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from router import Config
import native_backend


class NativeTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "Windows architecture")
    def test_native_kernel_architecture_under_emulation(self):
        expected = {"AMD64": "x64", "ARM64": "arm64", "X86": "x86"}.get(platform.machine().upper())
        if expected:
            self.assertEqual(native_backend.native_architecture(), expected)

    def test_arm64_is_rejected_before_loading_the_driver(self):
        with patch("native_backend.native_architecture", return_value="arm64"):
            with self.assertRaisesRegex(RuntimeError, "cannot run on ARM64"):
                native_backend.ensure_supported()
        with patch("native_backend.native_architecture", return_value="x64"):
            native_backend.ensure_supported()

    def test_policy_uses_one_ipc_action_for_future_processes(self):
        value = native_backend.encode_policy(Config(), "Local\\MT5RouterReady-123-abcd")
        prefix, encoded = value.split(":", 1)
        self.assertEqual(prefix, "MT5_ROUTER_V1")
        self.assertNotIn(",", value)
        data = json.loads(bytes.fromhex(encoded))
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["process"], "terminal64.exe")
        self.assertIsNone(data["pid"])

    @unittest.skipUnless(sys.platform == "win32", "Windows kernel objects")
    def test_real_readiness_event_and_single_capture_mutex(self):
        ready = native_backend.KernelObject()
        try:
            self.assertFalse(ready.signaled())
            ready.kernel.SetEvent.argtypes = [ctypes.c_void_p]
            self.assertTrue(ready.kernel.SetEvent(ready.handle))
            self.assertTrue(ready.signaled())
        finally:
            ready.close()
        mutex = native_backend.KernelObject(mutex=True)
        errors = []
        def another_owner():
            try:
                duplicate = native_backend.KernelObject(mutex=True)
                duplicate.close()
            except RuntimeError as e:
                errors.append(str(e))
        try:
            worker = threading.Thread(target=another_owner)
            worker.start(); worker.join(2)
            self.assertTrue(errors)
            self.assertIn("already running", errors[0])
        finally:
            mutex.close()


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(sys.platform == "win32", "Windows named pipe")
    async def test_stop_wakes_a_real_unconnected_backend_pipe(self):
        from ctypes import wintypes
        import os
        monitor = native_backend.ProcessMonitor()
        kernel = monitor.kernel
        kernel.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.DWORD, ctypes.c_void_p]
        kernel.CreateNamedPipeW.restype = wintypes.HANDLE
        kernel.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        pipe = kernel.CreateNamedPipeW(r"\\.\pipe\mitmproxy-transparent-proxy-" + str(os.getpid()),
                                       3, 6, 1, 65536, 65536, 0, None)
        self.assertNotEqual(pipe, ctypes.c_void_p(-1).value)
        result = []
        ready = threading.Event()
        def accept():
            ready.set()
            ok = kernel.ConnectNamedPipe(pipe, None)
            result.append(bool(ok) or ctypes.get_last_error() in (535, 232))
        worker = threading.Thread(target=accept, daemon=True)
        try:
            worker.start(); self.assertTrue(ready.wait(1))
            monitor.unblock_ipc()
            await asyncio.to_thread(worker.join, 2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(result, [True])
        finally:
            kernel.CloseHandle(pipe)
            monitor.close()

    async def test_pending_shutdown_keeps_monitoring_and_lock_until_process_exits(self):
        closed = asyncio.get_running_loop().create_future()
        exited = asyncio.Event()
        process, lock = Mock(), Mock()
        process.wait_exited = AsyncMock(side_effect=exited.wait)
        session = native_backend.Session(Mock(), closed, lock, process)
        real_wait = asyncio.wait
        async def quick_warning(tasks, **kw):
            return await real_wait(tasks, timeout=0.01)
        with patch("native_backend.asyncio.wait", quick_warning), self.assertLogs("mt5-router", level="WARNING"):
            closing = asyncio.create_task(session.close())
            await asyncio.sleep(0.03)
            self.assertFalse(closing.done())
            self.assertFalse(closed.cancelled())
            lock.close.assert_not_called()
            closed.set_result(None)
            await asyncio.sleep(0)
            lock.close.assert_not_called()
            exited.set()
            await closing
        process.close.assert_called_once()
        lock.close.assert_called_once()
        await session.close()  # Idempotent.
        lock.close.assert_called_once()

    async def test_cancelling_stop_does_not_release_capture_early(self):
        closed = asyncio.get_running_loop().create_future()
        process, lock = Mock(), Mock()
        process.wait_exited = AsyncMock()
        session = native_backend.Session(Mock(), closed, lock, process)
        closing = asyncio.create_task(session.close())
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0.01)
        self.assertFalse(closing.done())
        lock.close.assert_not_called()
        closed.set_result(None)
        with self.assertRaises(asyncio.CancelledError): await closing
        lock.close.assert_called_once()

    @unittest.skipUnless(sys.platform == "win32", "Windows process handle")
    async def test_real_process_handle_waits_for_exit_without_loading_driver(self):
        monitor = native_backend.ProcessMonitor()
        child = await asyncio.create_subprocess_exec(
            getattr(sys, "_base_executable", sys.executable), "-c", "import sys; sys.stdin.readline()",
            stdin=asyncio.subprocess.PIPE)
        try:
            monitor.mapping[:] = child.pid.to_bytes(4, "little")
            monitor.observe()
            self.assertTrue(monitor.handle)
            waiting = asyncio.create_task(monitor.wait_exited())
            await asyncio.sleep(0.03)
            self.assertFalse(waiting.done())
            child.stdin.write(b"exit\n"); await child.stdin.drain()
            await child.wait()
            async with asyncio.timeout(2): await waiting
        finally:
            if child.returncode is None: child.kill(); await child.wait()
            monitor.close()


if __name__ == "__main__": unittest.main()
