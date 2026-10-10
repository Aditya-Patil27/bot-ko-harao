import { useEffect, useRef, useState } from 'react';

type MsgHandler = (type: string, data: any) => void;

export function useWs(role: 'phone' | 'projector', onMessage: MsgHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);

  handlerRef.current = onMessage;

  useEffect(() => {
    let dead = false;

    function connect() {
      if (dead) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?role=${role}`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!dead) setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const { type, ...rest } = msg;
          handlerRef.current(type, rest);
        } catch {}
      };
    }

    connect();
    return () => {
      dead = true;
      wsRef.current?.close();
    };
  }, [role]);

  function send(type: string, data: Record<string, unknown> = {}) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  }

  return { connected, send };
}
