import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

const phoneSockets = new Set<WebSocket>();
const projectorSockets = new Set<WebSocket>();
let identifyHandler: ((ws: WebSocket, playerId: string) => void) | null = null;

export function onIdentify(handler: (ws: WebSocket, playerId: string) => void): void {
  identifyHandler = handler;
}

export function initWs(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const role = url.searchParams.get('role');

    if (role === 'projector') {
      projectorSockets.add(ws);
      ws.on('close', () => projectorSockets.delete(ws));
    } else {
      phoneSockets.add(ws);
      ws.on('close', () => phoneSockets.delete(ws));
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'identify' && msg.playerId && identifyHandler) {
          identifyHandler(ws, msg.playerId);
        }
      } catch {}
    });
  });
}

function send(ws: WebSocket, type: string, data: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

export function broadcastToPhones(type: string, data: any): void {
  for (const ws of phoneSockets) send(ws, type, data);
}

export function broadcastToProjector(type: string, data: any): void {
  for (const ws of projectorSockets) send(ws, type, data);
}

export function broadcastToAll(type: string, data: any): void {
  broadcastToPhones(type, data);
  broadcastToProjector(type, data);
}

export function sendToPlayer(ws: WebSocket, type: string, data: any): void {
  send(ws, type, data);
}
