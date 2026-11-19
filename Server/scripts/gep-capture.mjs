// Local verification sink for the Client's GEP relay. It accepts logon, then
// writes every ingest frame verbatim to a JSONL file and prints a summary.
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.OBVS_CAPTURE_PORT ?? 3100);
const output = resolve(process.env.OBVS_CAPTURE_FILE ?? 'gep-capture.jsonl');

function describeEvent(event) {
  const feature = event?.payload?.feature;
  const key = event?.payload?.key;
  return `${event.type}${feature ? ` ${feature}/${key}` : ''}`;
}

// Small self-check for the only formatting logic in this tool.
if (process.argv.includes('--self-test')) {
  assert.equal(
    describeEvent({ type: 'gep.raw', payload: { feature: 'me', key: 'health' } }),
    'gep.raw me/health'
  );
  assert.equal(describeEvent({ type: 'match.end', payload: {} }), 'match.end');
  console.log('self-test ok');
  process.exit(0);
}

const { WebSocketServer } = await import('ws');
const counts = new Map();
const out = createWriteStream(output, { flags: 'w' });
const server = new WebSocketServer({ host: '127.0.0.1', port });

server.on('listening', () => {
  console.log(`[capture] listening on ws://127.0.0.1:${port}/ingest`);
  console.log(`[capture] writing ${output}`);
});
server.on('error', (error) => {
  console.error(`[capture] server error: ${error.message}`);
  process.exitCode = 1;
});

server.on('connection', (socket, request) => {
  let loggedOn = false;
  console.log(`[capture] connection ${request.socket.remoteAddress ?? 'unknown'}`);

  socket.on('message', (data, isBinary) => {
    const text = isBinary ? '' : data.toString();
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      console.warn('[capture] dropped invalid JSON frame');
      return;
    }

    if (!loggedOn) {
      if (typeof event?.groupCode !== 'string') {
        socket.send(JSON.stringify({ accepted: false, reason: 'Group code is required.' }));
        socket.close(1008, 'Logon rejected');
        return;
      }
      loggedOn = true;
      socket.send(JSON.stringify({
        accepted: true,
        matchSecret: 'gep-capture-secret',
        capabilities: { gep: true, cv: { enabled: false, modelsLoaded: false }, fields: {} }
      }));
      console.log(
        `[capture] logon group=${event.groupCode} observer=${event.observerName} ` +
        `resume=${typeof event.matchSecret === 'string'}`
      );
      return;
    }

    if (typeof event?.type !== 'string' || typeof event.capturedAt !== 'string') {
      console.warn('[capture] dropped frame without type or capturedAt');
      return;
    }

    const label = describeEvent(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    out.write(`${JSON.stringify(event)}\n`);
    console.log(`[capture] ${label}`);
  });

  socket.on('close', () => console.log('[capture] disconnected'));
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log(`\n[capture] summary (${[...counts.values()].reduce((a, b) => a + b, 0)} events)`);
  for (const [label, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(6)}  ${label}`);
  }
  for (const socket of server.clients) socket.close();
  out.end(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
