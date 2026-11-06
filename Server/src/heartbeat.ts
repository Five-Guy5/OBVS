import { WebSocket, type WebSocketServer } from "ws";

type TrackedSocket = WebSocket & { isAlive?: boolean };

const HEARTBEAT_INTERVAL_MS = 30_000;

/** Mark a socket alive on every pong so the heartbeat can find dead peers. */
export function trackLiveness(socket: WebSocket): void {
  const state = socket as TrackedSocket;
  state.isAlive = true;
  socket.on("pong", () => { state.isAlive = true; });
}

/** Terminate sockets that missed the previous ping; stops when the server closes. */
export function startHeartbeat(
  server: WebSocketServer,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): void {
  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const state = socket as TrackedSocket;
      if (state.isAlive === false) {
        socket.terminate();
        continue;
      }
      state.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, intervalMs);
  heartbeat.unref();

  server.on("close", () => clearInterval(heartbeat));
}
