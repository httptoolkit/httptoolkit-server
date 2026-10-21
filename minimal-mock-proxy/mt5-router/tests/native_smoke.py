"""Optional Windows/UAC smoke test against an isolated mock-proxy instance.

Only the child test PID is selected. No MetaTrader/Proxifier settings are changed.
Usage: python tests/native_smoke.py PROXY_PORT CA_FILE
The proxy must mock http(s)://mock.example.test/target as `mocked`.
"""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import ssl
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


TARGET = "198.51.100.42"
EXCLUDED = "198.51.100.43"


async def expect_no_mock(ip, port):
    writer = None
    try:
        async with asyncio.timeout(1.5):
            reader, writer = await asyncio.open_connection(ip, port)
            writer.write(b"GET /target HTTP/1.1\r\nHost: mock.example.test\r\nConnection: close\r\n\r\n")
            await writer.drain()
            response = await reader.read()
            if b"mocked" in response:
                raise AssertionError(f"Negative control {ip}:{port} reached the proxy")
    except (OSError, TimeoutError):
        pass  # Documentation addresses have no required origin server.
    finally:
        if writer:
            writer.close()
            with contextlib.suppress(Exception):
                async with asyncio.timeout(1): await writer.wait_closed()


async def client(ca_file, selected=True):
    # Windows venv launchers may spawn a second process. Report the actual client.
    print(json.dumps({"pid": os.getpid()}), flush=True)
    # Wait until the parent has supplied our PID to the backend.
    if (await asyncio.to_thread(sys.stdin.readline)).strip() != "go":
        return
    if not selected:
        for port in (80, 443): await expect_no_mock(TARGET, port)
        print(json.dumps({"unrelated_process": True}), flush=True)
        return
    results = []
    for port in (80, 443):
        kwargs = {}
        if port == 443:
            kwargs = {"ssl": ssl.create_default_context(cafile=ca_file), "server_hostname": "mock.example.test"}
        async with asyncio.timeout(8):
            reader, writer = await asyncio.open_connection(TARGET, port, **kwargs)
            writer.write(b"GET /target HTTP/1.1\r\nHost: mock.example.test\r\nConnection: close\r\n\r\n")
            await writer.drain()
            response = await reader.read()
            writer.close()
            await writer.wait_closed()
        if b"mocked" not in response:
            raise RuntimeError("Mock response was not received.")
        results.append({"port": port, "mocked": True})
    await expect_no_mock(EXCLUDED, 80)
    await expect_no_mock(TARGET, 1950)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setblocking(False)
        for port in (80, 443):
            await asyncio.get_running_loop().sock_sendto(udp, b"mt5-router-test", (TARGET, port))
        await asyncio.sleep(0.1)
    results.append({"excluded_ip": True, "other_tcp_port": True, "udp": True})
    print(json.dumps(results), flush=True)


async def main():
    from router import Config, Router, destination_endpoint
    import native_backend
    try:
        native_backend.ensure_supported()
    except RuntimeError as e:
        print(f"NATIVE_UNSUPPORTED: {e}", flush=True)
        raise SystemExit(78)
    children = []
    running = None
    stop = asyncio.Event()
    callbacks = []
    async def spawn(mode):
        child = await asyncio.create_subprocess_exec(
            getattr(sys, "_base_executable", sys.executable), __file__, mode, sys.argv[2],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        children.append(child)  # Cleanup is registered before the PID handshake.
        async with asyncio.timeout(5):
            actual_pid = json.loads(await child.stdout.readline())["pid"]
        if type(actual_pid) is not int or actual_pid != child.pid:
            raise RuntimeError("Client PID handshake did not match the owned process")
        return child, actual_pid
    try:
        child, actual_pid = await spawn("--client")
        other, _ = await spawn("--unselected-client")
        router = Router(Config(proxy_port=int(sys.argv[1]), pid=actual_pid, direct_ips=(EXCLUDED,)))
        tcp, udp = router.handle_tcp, router.handle_udp
        async def observed_tcp(stream):
            callbacks.append(("tcp", stream.get_extra_info("pid"), destination_endpoint(stream)))
            await tcp(stream)
        async def observed_udp(stream):
            callbacks.append(("udp", stream.get_extra_info("pid"), destination_endpoint(stream)))
            await udp(stream)
        router.handle_tcp, router.handle_udp = observed_tcp, observed_udp
        running = asyncio.create_task(router.run(stop))
        async with asyncio.timeout(90):
            while not router.ready:
                if running.done():
                    await running
                    raise RuntimeError("Capture stopped before selecting the test client.")
                await asyncio.sleep(0.1)
            # Readiness is acknowledged by the native helper after filter setup.
            for owned in children:
                owned.stdin.write(b"go\n")
                await owned.stdin.drain()
            for owned, (stdout, stderr) in zip(children, await asyncio.gather(*(c.communicate() for c in children))):
                if owned.returncode: raise RuntimeError(stderr.decode(errors="replace"))
                print(stdout.decode(), end="")
            expected = [("tcp", actual_pid, (TARGET, port)) for port in (80, 443)]
            if sorted(callbacks) != sorted(expected):
                raise AssertionError(f"Native callbacks violated capture policy: {callbacks!r}")
            print(json.dumps({"negative_callbacks": 0}), flush=True)
    finally:
        stop.set()
        for child in children:
            if child.returncode is None:
                with contextlib.suppress(ProcessLookupError): child.kill()
            await child.wait()
        if running is not None:
            await asyncio.shield(running)


if __name__ == "__main__":
    if sys.argv[1] in ("--client", "--unselected-client"):
        asyncio.run(client(sys.argv[2], selected=sys.argv[1] == "--client"))
    else:
        import logging
        logging.basicConfig(level=logging.INFO)
        asyncio.run(main())
