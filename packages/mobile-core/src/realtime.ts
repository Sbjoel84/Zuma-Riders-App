import type { ServerEvent } from "@zuma/contracts";
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { API_URL, refreshAccessToken } from "./api";
import { tokenStore } from "./storage";

let socket: Socket | null = null;
const seen = new Set<string>();

/** One shared, authenticated socket per app. Reconnects with a fresh token after expiry. */
export async function connectRealtime(): Promise<Socket> {
  if (socket) return socket;
  const s = io(`${API_URL}/rt`, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    auth: async (cb) => cb({ token: await tokenStore.getAccess() }),
  });
  s.on("connect_error", async (err) => {
    if (err.message === "UNAUTHENTICATED") {
      const t = await refreshAccessToken();
      if (t) s.connect();
    }
  });
  socket = s;
  return s;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  seen.clear();
}

export function getSocket() {
  return socket;
}

/** Subscribe to a server event for the lifetime of a component. Duplicate deliveries are dropped by eventId. */
export function useServerEvent<T>(event: string, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let s: Socket | null = null;
    const fn = (e: ServerEvent<T>) => {
      if (e?.eventId) {
        if (seen.has(e.eventId)) return;
        seen.add(e.eventId);
        if (seen.size > 2000) seen.clear();
      }
      ref.current(e.data);
    };
    connectRealtime().then((sock) => {
      s = sock;
      sock.on(event, fn);
    });
    return () => {
      s?.off(event, fn);
    };
  }, [event]);
}

/** True while the socket is connected; screens use it to show a connectivity banner. */
export function useRealtimeConnected() {
  const [connected, setConnected] = useState(socket?.connected ?? false);
  useEffect(() => {
    let s: Socket | null = null;
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    connectRealtime().then((sock) => {
      s = sock;
      setConnected(sock.connected);
      sock.on("connect", on);
      sock.on("disconnect", off);
    });
    return () => {
      s?.off("connect", on);
      s?.off("disconnect", off);
    };
  }, []);
  return connected;
}
