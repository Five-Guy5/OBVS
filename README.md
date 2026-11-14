# OBVS

Open Broadcasting Valorant Software: a Valorant tournament overlay for the Missouri S&T Esports
Club. This is a greenfield, from-scratch implementation with no wire compatibility with legacy
Spectra. It is one monorepo holding the three project parts and the single shared protocol package.

| Path | Component |
| --- | --- |
| `Client` | Observer capture client — ow-electron + TypeScript settings shell |
| `Server` | Ingest, authoritative Match state, Broadcast — Node + TypeScript WebSocket service |
| `Frontend` | OBS overlay web app (Vite + TypeScript shell; UI framework undecided) |
| `Protocol` | Shared ingest event and Broadcast snapshot definitions |

`Server` is a Node + TypeScript service using `ws` for Observer ingest and frontend Broadcast;
Match state is in memory.
`Client` is an ow-electron desktop app; `Frontend` is the only web app.

## Requirements

- Node.js 22 or newer
- npm (bundled with Node)

## Commands

```sh
npm install
npm run build      # protocol, then frontend, client, and server
npm test           # protocol tests and workspace tests
npm run typecheck  # builds the protocol first, then typechecks every workspace
```

The frontend dev server runs with `npm run dev -w @obvs/frontend`.

The Server ingest endpoint runs with `npm run dev -w @obvs/server` after
`npm run build -w @obvs/protocol` (or the root `npm run build`) so the workspace dependency
resolves. It listens on `127.0.0.1:OBVS_PORT` by default (port `3000`). Set `OBVS_HOST` to bind
another interface, and `OBVS_AUTH_KEY` to require that key on logon; leave the key unset for open
ingest. The server speaks plain WebSocket, so terminate TLS in front of it for anything beyond local
development. `OBVS_MAX_PAYLOAD_BYTES` defaults to `8388608`, and `OBVS_IDLE_TIMEOUT_MS` defaults to
`600000`.

Frontends subscribe to Broadcast on a separate port, `OBVS_BROADCAST_PORT` (default `3001`), with
the group code in the query string: `ws://localhost:3001/?groupCode=obvs-demo`. Each subscriber
gets the full snapshot immediately, then a full snapshot on every change, at most 10 per second.
Broadcast is read-only and needs no key, and snapshots never carry the auth key or Match Secret.
`OBVS_HOST` binds both ports. `OBVS_MAX_SUBSCRIBERS` caps open subscriber sockets (default `256`).
Frontends never need to send anything, so inbound Broadcast frames are capped at 1 KiB, and a
subscriber more than 4 MiB behind is dropped so it reconnects with a fresh snapshot. Ingest checks
every payload field Match state reads and drops a malformed event without ending the Match. Both endpoints log one `[ingest]` or
`[broadcast]` line per connection, logon, subscription, and push, and Ctrl+C shuts down cleanly.

```sh
# PowerShell
$env:OBVS_AUTH_KEY = 'change-me'
npm run dev -w @obvs/server
```

The Client settings window runs with `npm run dev -w @obvs/client`. The auth key is optional; leave
it blank for an open-ingest server, and use "Remove saved key" to clear a stored key. The Client
rejects non-TLS server URLs by default. For local development only, set
`OBVS_ALLOW_INSECURE_URL=1` and use a loopback host (`localhost`, `127.0.0.1`, or `::1`); packaged
builds ignore the flag.

```sh
# PowerShell
$env:OBVS_ALLOW_INSECURE_URL = '1'
npm run dev -w @obvs/client
```

## Scaffold boundaries

This step only establishes the repository, the component folders, and the shared protocol
contract. The frontend is a plain Vite + TypeScript shell, so React, Svelte, Vue, or a no-framework
implementation can be adopted without changing the monorepo shape.

## Protocol versioning

Every ingest event and Broadcast snapshot shape is defined once in `Protocol/src/v1`. Consumers
import those shapes from `@obvs/protocol`; do not copy them into an app. A protocol change therefore
breaks every TypeScript consumer that uses the changed shape in the same build.

- `PROTOCOL_VERSION` is the wire version (currently `1`), separate from the package version.
- `SUPPORTED_INGEST_VERSIONS` lists the schema versions the server accepts. The chosen server stack
  must gate logons on that list before parsing an event.
- When the wire format changes, add `Protocol/src/v2/`, keep the previous version in the supported
  list, and let `@obvs/protocol` re-export the current shapes. Older schemas stay reachable as
  `@obvs/protocol/v1`, `@obvs/protocol/v2`, and so on. The event format is versioned, and the server
  must keep accepting at least the previous schema version.

CI (`.github/workflows/ci.yml`) verifies the component layout, runs the protocol and workspace
tests, and builds protocol, frontend, client, and server.
