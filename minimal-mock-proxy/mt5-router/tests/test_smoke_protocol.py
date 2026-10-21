import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
import importlib.util
from unittest.mock import patch, Mock, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from router import processes
spec = importlib.util.spec_from_file_location("native_smoke", Path(__file__).with_name("native_smoke.py"))
native_smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_smoke)


class SmokeProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_handshake_errors_always_reap_the_owned_child(self):
        for failure in (TimeoutError("PID timeout"), json.JSONDecodeError("invalid PID", "", 0)):
            child = Mock(pid=1234, returncode=None)
            child.stdout.readline = AsyncMock(side_effect=failure)
            child.wait = AsyncMock()
            with patch("native_backend.ensure_supported"), \
                 patch.object(native_smoke.asyncio, "create_subprocess_exec", AsyncMock(return_value=child)), \
                 patch.object(sys, "argv", ["native_smoke.py", "8888", "unused-ca"]):
                with self.assertRaises(type(failure)): await native_smoke.main()
            child.kill.assert_called_once()
            child.wait.assert_awaited_once()

    async def test_client_reports_actual_pid_and_cancel_exits_without_network(self):
        client = await asyncio.create_subprocess_exec(
            getattr(sys, "_base_executable", sys.executable), str(Path(__file__).with_name("native_smoke.py")),
            "--client", "unused-ca.pem", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            async with asyncio.timeout(5):
                actual = json.loads(await client.stdout.readline())["pid"]
            self.assertEqual(actual, client.pid)
            self.assertNotEqual(actual, os.getpid())
            self.assertTrue(any(pid == actual for pid, _ in processes()))
            client.stdin.write(b"cancel\n")
            await client.stdin.drain()
            async with asyncio.timeout(5):
                stdout, stderr = await client.communicate()
            self.assertEqual(client.returncode, 0, stderr.decode())
            self.assertEqual(stdout, b"")
        finally:
            if client.returncode is None:
                client.kill()
                await client.wait()


if __name__ == "__main__": unittest.main()
