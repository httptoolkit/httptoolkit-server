"""Raw TCP relay: Windows process capture -> existing HTTP CONNECT proxy.

TLS remains end-to-end between MT5 and minimal-mock-proxy. This module never
loads a private key, terminates TLS, or disables certificate verification.
"""
from __future__ import annotations

import asyncio
import contextlib
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import ipaddress
import logging
import os
from pathlib import PureWindowsPath
import sys

import mitmproxy_rs
import native_backend

LOG = logging.getLogger("mt5-router")
WEB_PORTS = frozenset((80, 443))


def canonical_ip(value):
    ip = ipaddress.ip_address(value)
    return str(ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip)


def destination_endpoint(stream):
    """Windows local capture uses sockname for the original packet destination.

    remote_endpoint is optional in mitmproxy_rs and is absent on Windows.
    Its get_extra_info API raises KeyError even with an explicit default=None.
    """
    try:
        endpoint = stream.get_extra_info("sockname")
    except KeyError as error:
        raise ValueError("Capture backend did not provide a destination socket address") from error
    if not isinstance(endpoint, (tuple, list)) or len(endpoint) != 2:
        raise ValueError("Capture backend provided an invalid destination socket address")
    host, port = endpoint
    if not isinstance(host, str) or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Capture backend provided an invalid destination socket address")
    return canonical_ip(host), port


@dataclass(frozen=True)
class Config:
    proxy_host: str = "127.0.0.1"
    proxy_port: int = 8888
    process: str = "terminal64.exe"
    pid: int | None = None
    direct_ips: tuple[str, ...] = ()
    connect_timeout: float = 10

    def __post_init__(self):
        try:
            if not ipaddress.ip_address(self.proxy_host).is_loopback:
                raise ValueError("The proxy must use a loopback IP address.")
        except ValueError as e:
            raise ValueError("Proxy address must be a loopback IP, e.g. 127.0.0.1 or ::1.") from e
        if type(self.proxy_port) is not int or not 1 <= self.proxy_port <= 65535:
            raise ValueError("Proxy port must be between 1 and 65535.")
        if not self.process or len(self.process) > 260 or PureWindowsPath(self.process).name != self.process or any(
            c in self.process for c in ',!*?/\\'
        ) or not self.process.lower().endswith(".exe"):
            raise ValueError("Process must be an exact executable name, e.g. terminal64.exe.")
        if self.pid is not None and (self.pid <= 0 or self.pid == os.getpid()):
            raise ValueError("PID must be positive and must not be the router's own PID.")
        if not 0 < self.connect_timeout <= 120:
            raise ValueError("Connection timeout must be between 0 and 120 seconds.")
        object.__setattr__(self, "direct_ips", tuple(dict.fromkeys(canonical_ip(x) for x in self.direct_ips)))
        if len(self.direct_ips) > 64 or any('%' in ip for ip in self.direct_ips):
            raise ValueError("Use at most 64 unscoped destination IP addresses.")

    def use_proxy(self, destination: tuple[str, int]) -> bool:
        ip, port = destination
        return port in WEB_PORTS and canonical_ip(ip) not in self.direct_ips

    def matches_process(self, pid, name):
        if pid == os.getpid():
            return False
        if self.pid is not None:
            return pid == self.pid
        return bool(name) and PureWindowsPath(name).name.casefold() == self.process.casefold()


def processes() -> list[tuple[int, str]]:
    """Snapshot exact executable names. Do not use backend substring matching."""
    if sys.platform != "win32":
        raise RuntimeError("MT5 Router requires 64-bit Windows.")

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    result = []
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(handle, ctypes.byref(entry))
        if not more:
            raise ctypes.WinError(ctypes.get_last_error())
        while more:
            result.append((entry.th32ProcessID, entry.szExeFile))
            more = kernel.Process32NextW(handle, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)
    return result


def selected_pids(config: Config, snapshot: list[tuple[int, str]]) -> list[int]:
    return sorted(pid for pid, name in snapshot if pid != os.getpid() and (
        pid == config.pid if config.pid is not None else name.casefold() == config.process.casefold()
    ))


async def connect_proxy(config: Config, destination: tuple[str, int]):
    """CONNECT for both HTTP and HTTPS, preserving bytes buffered after headers."""
    host, port = destination
    host = str(ipaddress.ip_address(host))  # No untrusted header text.
    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    writer = None
    try:
        async with asyncio.timeout(config.connect_timeout):
            reader, writer = await asyncio.open_connection(config.proxy_host, config.proxy_port, limit=16384)
            writer.write(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode("ascii"))
            await writer.drain()
            headers = await reader.readuntil(b"\r\n\r\n")
            status = headers.split(b"\r\n", 1)[0].split()
            if len(status) < 2 or status[0] not in (b"HTTP/1.0", b"HTTP/1.1") or status[1] != b"200":
                raise ConnectionError("Proxy refused CONNECT (expected HTTP 200).")
            return reader, writer
    except BaseException:
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                async with asyncio.timeout(1):
                    await writer.wait_closed()
        raise


async def copy_stream(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()
    # Preserve TCP half-close: a server may respond only after request EOF.
    with contextlib.suppress(OSError, RuntimeError, NotImplementedError):
        writer.write_eof()
        await writer.drain()


async def duplex(client, reader, writer):
    tasks = [asyncio.create_task(copy_stream(client, writer)),
             asyncio.create_task(copy_stream(reader, client))]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def wait_for_proxy(config, stop, wait_seconds=0):
    """Wait for CONNECT support; None waits until ready or Stop, including late retries."""
    loop = asyncio.get_running_loop()
    deadline = None if wait_seconds is None else loop.time() + wait_seconds
    async def probe_once():
        probe = None
        try:
            # Target the proxy's own loopback endpoint, with no tunnel payload.
            # This checks CONNECT without requesting an external connection.
            _, probe = await connect_proxy(config, (config.proxy_host, config.proxy_port))
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            raise ConnectionError("Proxy did not return a valid CONNECT response.") from error
        finally:
            if probe is not None:
                probe.close()
                with contextlib.suppress(OSError):
                    async with asyncio.timeout(1):
                        await probe.wait_closed()
    stopped = asyncio.create_task(stop.wait())
    attempt = None
    try:
        while not stop.is_set():
            try:
                timeout = config.connect_timeout if wait_seconds in (0, None) else min(config.connect_timeout, max(0.01, deadline - loop.time()))
                attempt = asyncio.create_task(probe_once())
                done, _ = await asyncio.wait((attempt, stopped), timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                if stopped in done:
                    return False
                if attempt not in done:
                    raise TimeoutError("Proxy connection probe timed out")
                await attempt
                return not stop.is_set()
            except (OSError, TimeoutError):
                if wait_seconds == 0:
                    raise
                if deadline is not None and loop.time() >= deadline:
                    raise TimeoutError(f"Proxy {config.proxy_host}:{config.proxy_port} was not available within {wait_seconds:g} seconds") from None
            finally:
                if attempt is not None:
                    attempt.cancel()
                    await asyncio.gather(attempt, return_exceptions=True)
            try:
                async with asyncio.timeout(0.25 if deadline is None else min(0.25, max(0.01, deadline - loop.time()))):
                    await stop.wait()
            except TimeoutError:
                pass
        return False
    finally:
        stopped.cancel()
        if attempt is not None:
            attempt.cancel()
        await asyncio.gather(stopped, *([attempt] if attempt else []), return_exceptions=True)


class Router:
    def __init__(self, config: Config, on_state=None, proxy_wait=0):
        self.config = config
        self.on_state = on_state or (lambda kind, message: None)
        self.connections: set[asyncio.Task] = set()
        self.session = None
        self.ready = False
        self.closing = False
        if proxy_wait is not None and not 0 <= proxy_wait <= 600:
            raise ValueError("Proxy startup wait must be between 0 and 600 seconds")
        self.proxy_wait = proxy_wait

    async def handle_tcp(self, stream):
        task = asyncio.current_task()
        self.connections.add(task)
        writer = None
        try:
            destination = destination_endpoint(stream)
            try:
                pid = stream.get_extra_info("pid")
                process_name = stream.get_extra_info("process_name")
            except KeyError as error:
                raise ValueError("Capture backend did not provide process metadata") from error
            # Native selection is authoritative at connect time. Never turn an
            # unexpected captured stream into a new direct connection.
            if self.closing or not self.config.matches_process(pid, process_name) \
                    or not self.config.use_proxy(destination):
                raise ConnectionError("Unexpected stream outside the native capture policy")
            LOG.info("PID %s TCP %s:%s -> proxy", pid, *destination)
            reader, writer = await connect_proxy(self.config, destination)
            await duplex(stream, reader, writer)
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError) as e:
            LOG.error("TCP connection failed: %s", type(e).__name__)
        finally:
            with contextlib.suppress(OSError):
                stream.close()
            if writer is not None:
                writer.close()
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(1):
                        await writer.wait_closed()
            self.connections.discard(task)

    async def handle_udp(self, stream):
        # The native filter never captures UDP. Keep the required API callback
        # fail-closed if a mismatched/old native helper somehow supplies it.
        with contextlib.suppress(OSError):
            stream.close()
        LOG.error("Unexpected UDP callback: native helper policy mismatch")

    async def run(self, stop: asyncio.Event):
        if stop.is_set():
            return
        native_backend.ensure_supported()
        if self.proxy_wait != 0:
            self.on_state("starting", "Waiting for mock proxy")
            LOG.info("Waiting for CONNECT proxy %s:%s (%s)", self.config.proxy_host, self.config.proxy_port,
                     "until ready or Stop" if self.proxy_wait is None else f"up to {self.proxy_wait:g} seconds")
        if not await wait_for_proxy(self.config, stop, self.proxy_wait):
            return
        LOG.info("Starting capture. Accept the Windows administrator prompt if shown.")
        startup = asyncio.create_task(native_backend.start(self.config, self.handle_tcp, self.handle_udp))
        stopped = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait((startup, stopped), timeout=60, return_when=asyncio.FIRST_COMPLETED)
            if startup not in done:
                if stop.is_set():
                    return
                raise TimeoutError("Administrator startup/readiness did not complete within 60 seconds.")
            self.session = await startup
            if stop.is_set():
                return
            self.ready = True
            self.on_state("running", "Running - TCP 80 / 443")
            LOG.info("Capture ready for %s; TCP 80/443 -> %s:%s. Other ports and UDP stay outside the relay.",
                     f"PID {self.config.pid}" if self.config.pid else self.config.process,
                     self.config.proxy_host, self.config.proxy_port)
            done, _ = await asyncio.wait((self.session.closed, stopped), return_when=asyncio.FIRST_COMPLETED)
            if self.session.closed in done and not stop.is_set():
                await self.session.closed
                raise RuntimeError("Windows capture stopped unexpectedly. Restart the router.")
        finally:
            self.closing = True
            self.ready = False
            stopped.cancel()
            if not startup.done():
                startup.cancel()
            await asyncio.gather(startup, stopped, return_exceptions=True)
            if self.session is None and not startup.cancelled() and startup.exception() is None:
                self.session = startup.result()
            # Cancel every captured web flow before closing the native stack.
            tasks = list(self.connections)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.session is not None:
                self.on_state("stopping", "Stopping - waiting for native helper")
                await self.session.close()
                LOG.info("Capture stopped. Relayed web connections may need reconnecting.")
