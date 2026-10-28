# OBVS

Open Broadcasting Valorant Software: a Valorant tournament overlay for the Missouri S&T Esports
Club. This is a greenfield, from-scratch implementation with no wire compatibility with legacy
Spectra. It is one monorepo holding the three project parts and the single shared protocol package.

| Path | Component |
| --- | --- |
| `Client` | Observer capture client — implementation stack undecided |
| `Server` | Ingest, authoritative Match state, Broadcast — implementation stack undecided |
| `Frontend` | OBS overlay web app (Vite + TypeScript shell; UI framework undecided) |
| `Protocol` | Shared ingest event and Broadcast snapshot definitions |

`Client` and `Server` intentionally contain no implementation code. Their language, framework,
build tooling, transport, and persistence choices belong to their owners. Add the chosen stack and
its build/CI steps to those folders when implementation starts. `Frontend` is the only web app.

## Requirements

- Node.js 22 or newer
- npm (bundled with Node)

## Commands

```sh
npm install
npm run build      # protocol, then frontend
npm test           # protocol tests
npm run typecheck  # builds the protocol first, then typechecks every workspace
```

The frontend dev server runs with `npm run dev -w @obvs/frontend`.

## Scaffold boundaries

This step only establishes the repository, the component folders, and the shared protocol
contract. The frontend is a plain Vite + TypeScript shell, so React, Svelte, Vue, or a no-framework
implementation can be adopted without changing the monorepo shape. Client and Server are
placeholders until their owners choose a stack.

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

CI (`.github/workflows/ci.yml`) verifies the component layout, runs the protocol tests, and builds
the implemented workspaces. Add the client and server builds once their stacks are selected.
