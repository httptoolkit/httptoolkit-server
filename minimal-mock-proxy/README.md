# Minimal Mock Proxy

For MetaTrader 5 process interception on Windows, the optional
[MT5 Router app](mt5-router/README.md) routes TCP ports 80/443 into this proxy.
Its portable build is `dist/mt5-router/MT5Router/MT5Router.exe`.

A small HTTP/HTTPS MITM proxy that applies supported HTTP Toolkit exported rules using Mockttp.

## Quick Start

The included `rules.json` is a portable example: it mocks POST requests to
`https://example.test/gate`, serves the current proxy CA at
`http://proxy.example.test/ca.pem`, and passes through other HTTP/WebSocket traffic.
Replace it with your own HTTP Toolkit export or select one with `--rules`.

### 1. Install Dependencies

```bash
npm install
```

### 2. Build (Production)

```bash
npm run build
npm start -- --port 8888 --rules rules.json
```

### 3. Development (No Build Required)

```bash
npm run dev -- --port 8888 --rules rules.json
```

### Run on Another Computer with a Single JavaScript Bundle

On the build computer, run:

```bash
npm run build:bundle
```

Copy `dist/standalone/server.js`, your rules JSON, and any response files referenced
by the rules to the other computer. Install Node.js 20 or newer there; no npm
install or `node_modules` folder is required on that computer.

For example, with `server.js` beside a `rules` folder:

```bash
node server.js --port 8002 --rules rules/MockProxy.json --log-level debug --telegram-chat-id "YOUR_CHAT_ID" --telegram-bot-token "YOUR_BOT_TOKEN" --add-default-passthrough
```

Rules and response files remain external and editable. Response files are read
for every matched request, so edits take effect immediately. Restart the proxy
after editing the rules JSON. Relative file paths are resolved from the working
directory. Update any absolute paths for the new computer. The proxy generates a
CA certificate on first startup and logs its
location with `--log-level debug`; configure the requesting application to trust
that certificate.

## Command Line Options

### Required Flags

- `--rules <path>` - Path to HTTP Toolkit rules JSON file (e.g., `--rules rules.json`)

### Optional Flags

- `--port <number>` - Port to listen on (default: `8888`; `0` selects a free port and logs the actual port)
- `--host <IP>` - Bind address (default: `127.0.0.1`). Use `::1` for IPv6 loopback. Use `0.0.0.0` or `::` explicitly to accept network connections; the proxy does not provide authentication.
- `--log-level <level>` - Logging level: `error`, `warn`, `info`, `debug` (default: `info`)
- `--body-preview <chars>` - Opt in to text response previews, from `0` to `65536` characters (default: `0`, disabled). Binary and compressed bodies are never decoded for logging. Previews can contain sensitive data.
- `--max-body-size <bytes>` - Maximum body capture and decoded body matching size, from `1` to `67108864` bytes (default: `1048576`). Larger bodies are omitted from logging and body matching; passthrough traffic is streamed without truncation. Set this high enough for bodies that your rules need to match.
- `--add-default-passthrough` - Add unmatched passthrough if rules don't include wildcard passthrough
- `--telegram-bot-token <token>` - Telegram bot token for error notifications
- `--telegram-chat-id <id>` - Telegram chat ID for error notifications
- `--help` or `-h` - Show usage information

Unknown flags, missing values, invalid integers, and unsupported log levels fail
startup. Telegram notifications require both Telegram flags. Request logs redact
URL credentials and query values. Body-preview limits apply before text decoding;
response event capture is disabled at `warn` and `error` log levels.

## Examples

### Basic Usage

```bash
# Development mode
npm run dev -- --port 8003 --rules rules.json

# Production mode
npm run build
npm start -- --port 8003 --rules rules.json
```

### With Logging Configuration

```bash
npm run dev -- --port 8003 --rules rules.json --log-level debug --body-preview 2000
```

### With Telegram Notifications

```bash
npm run dev -- --port 8003 --rules rules.json \
  --telegram-bot-token "123456789:ABCdefGHIjklMNOpqrsTUVwxyz" \
  --telegram-chat-id "-1001234567890"
```

### Multiple Instances

```bash
# Terminal 1
npm run dev -- --port 8001 --rules ../rules/rules-a.json

# Terminal 2
npm run dev -- --port 8002 --rules ../rules/rules-b.json --log-level warn
```

## HTTPS Certificate

The proxy generates a CA certificate automatically on first run. To intercept HTTPS traffic:

1. Trust the generated CA certificate (stored in your user config directory)
2. Import it into your system's trusted root certification authorities
3. Restart your applications to pick up the new certificate

The built-in `amiusing.httptoolkit.tech/certificate` rule always serves this
proxy's CA, including when importing a desktop export that references another
CA file. The supplied rules use the portable `proxy-certificate` action, which
does not contain a computer-specific path. Existing CA files are checked for a
matching key and certificate; invalid material is reported without replacing a
certificate that clients may already trust.
The certificate endpoint uses the CA loaded by the running proxy. Restart after
intentionally replacing CA files; ordinary response file reloads do not rotate
the active CA.

## Available Scripts

- `npm run dev` - Run in development mode with auto-reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm run build:bundle` - Type-check and bundle runtime dependencies into `dist/standalone/server.js`
- `npm run typecheck` - Check TypeScript types without building
- `npm test` - Build and run rule, networking, HTTPS, HTTP/2, WebSocket, and CLI regression tests
- `npm run test:bundle` - Build and test the standalone bundle in a directory without `node_modules`
- `npm start` - Run the compiled JavaScript (requires build first)

`server.ts`, `runtime.ts`, and `rules.ts` are the runtime source. The root
`server.js` is a compatibility launcher for the compiled output and requires
`npm run build` first. The standalone bundle contains the same runtime.

Mockttp is pinned because enforcing a bind address requires a guarded adapter
for its local transport. Socket tests verify loopback isolation. Re-run the
full test suite when upgrading it. The `basic-ftp` override installs a patched
version in the optional upstream-proxy dependency chain.

Rules format
------------

Use an HTTP Toolkit export with a root `items` array. Rules are validated before
registration, and errors identify the rule ID or its position in the tree.
Unsupported features fail startup instead of being ignored.

Groups retain their displayed order. All matchers in a rule must match.
Explicit numeric priorities and `always`, `once`, `twice`, `thrice`, and `times`
completion checkers are supported. Rules without a completion checker repeat.
An unrestricted, unprioritized, always-active wildcard passthrough becomes a
fallback; scoped passthrough retains its constraints. The flag adds an HTTP
fallback only when one is absent. WebSockets use their own exported rules.

Supported matchers: wildcard, method, protocol, host, hostname, port, simple-path,
regex-path, regex-url, header, query, exact-query-string, form-data,
multipart-form-data, raw-body, raw-body-includes, raw-body-regexp, json-body,
json-body-matching, and cookie.

Supported HTTP actions: simple responses, file responses, proxy-certificate,
passthrough, close-connection, reset-connection, and timeout. Supported WebSocket
actions: ws-passthrough, ws-echo, ws-listen, ws-reject, close-connection,
reset-connection, and timeout. Actions can be preceded by delays. Portable
passthrough forwarding, extra CA certificates, certificate-error settings, and
connection-error settings are supported. Desktop callback channels, serialized
transforms, and other unsupported action options are rejected explicitly.

Missing response files fail startup. A file removed after startup returns 500;
it does not silently return an empty successful response. Static/file response
headers are sanitized for HTTP/1 and HTTP/2, and content lengths are recomputed.

Example:

```
{
  "id": "root",
  "title": "Rules",
  "isRoot": true,
  "items": [
    {
      "id": "rule-1",
      "type": "http",
      "activated": true,
      "matchers": [
        { "type": "method", "method": 1, "uiType": "POST" },
        { "type": "simple-path", "path": "https://example.com/gate" }
      ],
      "steps": [
        {
          "type": "simple",
          "status": 200,
          "headers": { "content-type": "text/plain" },
          "data": { "type": "Buffer", "data": [72,101,108,108,111] }
        }
      ],
      "completionChecker": { "type": "always" }
    },
    {
      "id": "fallback",
      "type": "http",
      "activated": true,
      "matchers": [ { "type": "wildcard", "uiType": "default-wildcard" } ],
      "steps": [ { "type": "passthrough" } ],
      "completionChecker": { "type": "always" }
    }
  ]
}
```
