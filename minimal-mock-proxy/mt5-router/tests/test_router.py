import asyncio
import contextlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from router import Config, Router, connect_proxy, duplex, processes, selected_pids, destination_endpoint, wait_for_proxy


class ConfigTests(unittest.TestCase):
    def test_windows_destination_uses_sockname_without_optional_remote_endpoint(self):
        class WindowsStream:
            def __init__(self, address): self.address = address
            def get_extra_info(self, key, default=None):
                if key == "sockname": return self.address
                if key == "peername": return ("192.0.2.1", 55000)
                if default is not None: return default
                raise KeyError(key)
        for address in (("203.0.113.1", 80), ("2001:0db8::1", 443)):
            stream = WindowsStream(address)
            with self.assertRaises(KeyError): stream.get_extra_info("remote_endpoint", None)
            self.assertEqual(destination_endpoint(stream), ("203.0.113.1", 80) if address[1] == 80 else ("2001:db8::1", 443))

    def test_invalid_or_missing_destination_metadata_is_rejected(self):
        from unittest.mock import Mock
        stream = Mock()
        stream.get_extra_info.side_effect = KeyError("sockname")
        with self.assertRaisesRegex(ValueError, "destination socket address"):
            destination_endpoint(stream)
        stream.get_extra_info.side_effect = None
        for endpoint in (None, ("203.0.113.1",), ("203.0.113.1", 443, "extra"),
                         ("not-an-IP", 443), ("203.0.113.1", True), ("203.0.113.1", 0)):
            stream.get_extra_info.return_value = endpoint
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError): destination_endpoint(stream)

    def test_web_ports_and_direct_exclusions(self):
        c = Config(direct_ips=("2001:0db8::1", "203.0.113.1"))
        self.assertTrue(c.use_proxy(("203.0.113.2", 80)))
        self.assertTrue(c.use_proxy(("2001:db8::2", 443)))
        self.assertFalse(c.use_proxy(("203.0.113.2", 1950)))
        self.assertFalse(c.use_proxy(("203.0.113.1", 443)))
        self.assertFalse(c.use_proxy(("2001:db8::1", 443)))

    def test_mapped_ipv4_exclusions_match_both_representations(self):
        c = Config(direct_ips=("::ffff:203.0.113.20", "203.0.113.20"))
        self.assertEqual(c.direct_ips, ("203.0.113.20",))
        self.assertFalse(c.use_proxy(("203.0.113.20", 443)))
        self.assertFalse(c.use_proxy(("::ffff:203.0.113.20", 80)))
        self.assertTrue(c.use_proxy(("203.0.113.21", 443)))

    def test_invalid_config(self):
        for kwargs in ({"proxy_host": "0.0.0.0"}, {"proxy_host": "example.com"},
                       {"proxy_port": 0}, {"proxy_port": 65536}, {"proxy_port": True},
                       {"process": ""}, {"process": "!terminal64.exe"},
                       {"process": "terminal64.exe,chrome.exe"}, {"process": r"C:\MT5\terminal64.exe"},
                       {"pid": os.getpid()}, {"pid": 0}, {"direct_ips": ("bad\r\nHost: test",)},
                       {"connect_timeout": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Config(**kwargs)

    def test_exact_case_insensitive_process_selection(self):
        snapshot = [(11, "TERMINAL64.EXE"), (12, "terminal64.exe"),
                    (13, "other-terminal64.exe"), (14, "metatester64.exe"),
                    (os.getpid(), "terminal64.exe")]
        self.assertEqual(selected_pids(Config(), snapshot), [11, 12])
        self.assertEqual(selected_pids(Config(pid=14), snapshot), [14])
        self.assertEqual(selected_pids(Config(), []), [])

    @unittest.skipUnless(sys.platform == "win32", "Windows API")
    def test_native_process_snapshot(self):
        snapshot = processes()
        self.assertTrue(any(pid == os.getpid() and name.lower().endswith(".exe") for pid, name in snapshot))


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_login_start_waits_for_late_proxy(self):
        from unittest.mock import AsyncMock, Mock
        writer = AsyncMock()
        writer.close = Mock()
        connect = AsyncMock(side_effect=[ConnectionRefusedError(), (None, writer)])
        with patch("router.connect_proxy", connect):
            self.assertTrue(await wait_for_proxy(Config(), asyncio.Event(), 2))
        self.assertEqual(connect.await_count, 2)
        writer.close.assert_called_once()
        writer.wait_closed.assert_awaited_once()

    async def test_login_start_waits_through_all_proxy_retries_until_connect_is_ready(self):
        from unittest.mock import AsyncMock, Mock
        writer = AsyncMock()
        writer.close = Mock()
        connect = AsyncMock(side_effect=[ConnectionRefusedError()] * 4 + [(None, writer)])
        with patch("router.connect_proxy", connect):
            async with asyncio.timeout(3):
                self.assertTrue(await wait_for_proxy(Config(), asyncio.Event(), None))
        self.assertEqual(connect.await_count, 5)
        writer.close.assert_called_once()

    async def test_stop_interrupts_a_stalled_proxy_probe_without_starting_capture(self):
        from unittest.mock import AsyncMock
        entered = asyncio.Event()
        async def stalled(*args, **kwargs):
            entered.set()
            await asyncio.Future()
        stop = asyncio.Event()
        with patch("router.native_backend.ensure_supported"), \
             patch("router.asyncio.open_connection", stalled), \
             patch("router.native_backend.start", new_callable=AsyncMock) as native:
            task = asyncio.create_task(Router(Config(), proxy_wait=None).run(stop))
            await entered.wait()
            stop.set()
            async with asyncio.timeout(1): await task
            native.assert_not_called()

    async def test_non_proxy_listener_cannot_start_native_capture(self):
        from unittest.mock import AsyncMock
        async def handler(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"This is not an HTTP proxy\r\n")
            await writer.drain()
        port = await self.server(handler)
        with patch("router.native_backend.ensure_supported"), \
             patch("router.native_backend.start", new_callable=AsyncMock) as native:
            with self.assertRaisesRegex(ConnectionError, "valid CONNECT response"):
                await Router(Config(proxy_port=port)).run(asyncio.Event())
            native.assert_not_called()

    async def test_readiness_probes_only_loopback_connect_without_tunnel_payload(self):
        seen = []
        completed = asyncio.Event()
        async def handler(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            seen.append(await reader.read())
            completed.set()
        port = await self.server(handler)
        self.assertTrue(await wait_for_proxy(Config(proxy_port=port), asyncio.Event()))
        async with asyncio.timeout(1): await completed.wait()
        self.assertEqual(seen, [f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode(), b""])

    async def proxy_ready(self, reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await reader.read()

    async def test_proxy_wait_timeout_does_not_start_capture(self):
        from unittest.mock import AsyncMock
        with patch("router.native_backend.ensure_supported"), \
             patch("router.asyncio.open_connection", new_callable=AsyncMock, side_effect=ConnectionRefusedError()), \
             patch("router.native_backend.start", new_callable=AsyncMock) as native:
            with self.assertRaisesRegex(TimeoutError, "not available"):
                await Router(Config(), proxy_wait=0.03).run(asyncio.Event())
            native.assert_not_called()

    async def test_missing_process_metadata_closes_stream_without_uncaught_keyerror(self):
        from unittest.mock import Mock, AsyncMock
        for missing in ("pid", "process_name"):
            stream = Mock()
            def metadata(key):
                if key == "sockname": return ("203.0.113.1", 443)
                if key == missing: raise KeyError(key)
                return 424242 if key == "pid" else "terminal64.exe"
            stream.get_extra_info.side_effect = metadata
            router = Router(Config(pid=424242))
            with patch("router.connect_proxy", new_callable=AsyncMock) as connect, \
                 self.assertLogs("mt5-router", level="ERROR"):
                await router.handle_tcp(stream)
            connect.assert_not_called()
            stream.close.assert_called_once()
            self.assertEqual(router.connections, set())

    async def server(self, handler):
        tasks = set()
        async def guarded(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            try:
                await handler(reader, writer)
            finally:
                writer.close()
                tasks.discard(task)
        server = await asyncio.start_server(guarded, "127.0.0.1", 0)
        async def cleanup():
            server.close()
            await server.wait_closed()
            for task in list(tasks):
                task.cancel()
            await asyncio.gather(*list(tasks), return_exceptions=True)
        self.addAsyncCleanup(cleanup)
        return server.sockets[0].getsockname()[1]

    async def test_connect_preserves_buffered_bytes_and_ipv6_authority(self):
        seen = []
        async def handler(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n\x00buffered\xff")
            await writer.drain()
        port = await self.server(handler)
        reader, writer = await connect_proxy(Config(proxy_port=port), ("2001:db8::1", 443))
        self.assertEqual(await reader.read(), b"\x00buffered\xff")
        self.assertEqual(seen, [b"CONNECT [2001:db8::1]:443 HTTP/1.1\r\nHost: [2001:db8::1]:443\r\n\r\n"])
        writer.close()
        await writer.wait_closed()

    async def test_rejected_proxy_never_connects_directly(self):
        async def handler(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 407 Authentication required\r\n\r\nprivate response")
            await writer.drain()
        port = await self.server(handler)
        with self.assertRaisesRegex(ConnectionError, "refused CONNECT") as error:
            await connect_proxy(Config(proxy_port=port), ("203.0.113.1", 80))
        self.assertNotIn("private", str(error.exception))

    async def test_connect_timeout(self):
        async def handler(reader, writer):
            await reader.read()
        port = await self.server(handler)
        with self.assertRaises(TimeoutError):
            await connect_proxy(Config(proxy_port=port, connect_timeout=0.05), ("203.0.113.1", 443))

    async def test_oversized_proxy_headers_are_bounded(self):
        async def handler(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 OK\r\nX: " + b"a" * 20000 + b"\r\n\r\n")
            await writer.drain()
        port = await self.server(handler)
        with self.assertRaises(asyncio.LimitOverrunError):
            await connect_proxy(Config(proxy_port=port), ("203.0.113.1", 80))

    async def test_half_close_and_large_binary_roundtrip(self):
        payload = bytes(range(256)) * 4096
        async def origin(reader, writer):
            body = await reader.read()  # Respond only after receiving EOF.
            writer.write(body[::-1])
            await writer.drain()
        origin_port = await self.server(origin)

        async def relay(reader, writer):
            upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", origin_port)
            class Client:
                read = reader.read
                write = writer.write
                drain = writer.drain
                write_eof = writer.write_eof
            try:
                await duplex(Client(), upstream_reader, upstream_writer)
            finally:
                upstream_writer.close()
                await upstream_writer.wait_closed()
        relay_port = await self.server(relay)
        reader, writer = await asyncio.open_connection("127.0.0.1", relay_port)
        writer.write(payload)
        await writer.drain()
        writer.write_eof()
        async with asyncio.timeout(10):
            response = await reader.read()
        self.assertEqual(response, payload[::-1])
        writer.close()
        await writer.wait_closed()

    async def test_router_waits_for_native_readiness_and_stops_cleanly(self):
        from unittest.mock import AsyncMock
        stop = asyncio.Event()
        ready = asyncio.Event()
        class Session:
            def __init__(self):
                self.closed = asyncio.get_running_loop().create_future()
                self.did_close = False
            async def close(self):
                self.did_close = True
                self.closed.set_result(None)
        session = Session()
        states = []
        async def start(*args):
            await ready.wait()
            return session
        port = await self.server(self.proxy_ready)
        route = Router(Config(proxy_port=port), lambda *state: states.append(state))
        with patch("router.native_backend.ensure_supported"), patch("router.native_backend.start", start):
            task = asyncio.create_task(route.run(stop))
            await asyncio.sleep(0.03)
            self.assertFalse(route.ready)
            self.assertEqual(states, [])
            ready.set()
            while not route.ready:
                await asyncio.sleep(0)
            self.assertEqual(states[0][0], "running")
            stop.set()
            await task
        self.assertTrue(session.did_close)
        self.assertFalse(route.ready)

    async def test_stop_cancels_pending_administrator_startup(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        async def pending(*args):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        stop = asyncio.Event()
        port = await self.server(self.proxy_ready)
        with patch("router.native_backend.ensure_supported"), patch("router.native_backend.start", pending):
            task = asyncio.create_task(Router(Config(proxy_port=port)).run(stop))
            await started.wait()
            stop.set()
            async with asyncio.timeout(1):
                await task
        self.assertTrue(cancelled.is_set())

    async def test_unexpected_native_exit_is_reported(self):
        from unittest.mock import AsyncMock
        class Session:
            def __init__(self):
                self.closed = asyncio.get_running_loop().create_future()
                self.closed.set_result(None)
            async def close(self): pass
        port = await self.server(self.proxy_ready)
        with patch("router.native_backend.ensure_supported"), \
             patch("router.native_backend.start", AsyncMock(return_value=Session())):
            with self.assertRaisesRegex(RuntimeError, "stopped unexpectedly"):
                await Router(Config(proxy_port=port)).run(asyncio.Event())

    async def test_udp_is_never_relayed(self):
        from unittest.mock import Mock
        stream = Mock()
        with patch("mitmproxy_rs.udp.open_udp_connection") as connect:
            with self.assertLogs("mt5-router", level="ERROR"):
                await Router(Config()).handle_udp(stream)
        stream.close.assert_called_once()
        connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
