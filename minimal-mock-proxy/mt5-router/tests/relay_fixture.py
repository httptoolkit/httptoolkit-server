"""Test adapter only: supply a captured stream without loading a driver."""
import asyncio
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from router import Config, Router, wait_for_proxy


async def main():
    router = Router(Config(proxy_port=int(sys.argv[1]), pid=424242))
    # Exercise the actual Mockttp CONNECT readiness handshake without a driver.
    await wait_for_proxy(router.config, asyncio.Event())
    destination = (sys.argv[2], int(sys.argv[3]))
    async def accept(reader, writer):
        class Captured:
            read = reader.read
            write = writer.write
            drain = writer.drain
            write_eof = writer.write_eof
            close = writer.close
            def get_extra_info(self, key, default=None):
                # Match the pinned Windows backend: remote_endpoint is absent,
                # sockname is the original destination and missing None defaults raise.
                values = {"sockname": destination, "peername": writer.get_extra_info("peername"),
                          "pid": 424242, "process_name": "terminal64.exe"}
                if key in values:
                    return values[key]
                if default is not None:
                    return default
                raise KeyError(key)
        with patch("router.processes", return_value=[(424242, "terminal64.exe")]):
            await router.handle_tcp(Captured())
    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    print(server.sockets[0].getsockname()[1], flush=True)
    await server.serve_forever()


asyncio.run(main())
