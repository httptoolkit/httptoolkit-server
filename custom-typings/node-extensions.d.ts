// Undocumented module that allows us to turn a stream into a usable net.Socket.
// Deprecated in Node 12+, but useful in the meantime.
declare module "_stream_wrap" {
    import * as net from 'net';
    import * as streams from 'stream';

    class SocketWrapper extends net.Socket {
        constructor(stream: streams.Duplex);
        stream?: streams.Duplex & Partial<net.Socket>;
    }

    export = SocketWrapper;
}
