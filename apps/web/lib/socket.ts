import { io, type Socket as IOSocket } from "socket.io-client";

type EventHandler = (payload?: unknown) => void;

const DEFAULT_HTTP_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";
const DEFAULT_SOCKET_BASE = process.env.NEXT_PUBLIC_SOCKET_URL ?? DEFAULT_HTTP_BASE;
const SOCKET_TRANSPORT_MODE = process.env.NEXT_PUBLIC_SOCKET_TRANSPORT ?? "auto";

const toWebSocketUrl = (value: string): string => {
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return value;
  }
  if (value.startsWith("https://")) {
    return value.replace("https://", "wss://");
  }
  if (value.startsWith("http://")) {
    return value.replace("http://", "ws://");
  }
  return `ws://${value}`;
};

const SOCKET_URL = `${toWebSocketUrl(DEFAULT_SOCKET_BASE).replace(/\/$/, "")}/ws`;

interface WireMessage {
  event: string;
  payload?: unknown;
}

export interface GameSocket {
  on<T = unknown>(event: string, handler: (payload: T) => void): GameSocket;
  emit(event: string, payload?: unknown): boolean;
  disconnect(): void;
}

class SocketIoGameSocket implements GameSocket {
  constructor(private readonly socket: IOSocket) {}

  on<T = unknown>(event: string, handler: (payload: T) => void): GameSocket {
    this.socket.on(event, handler as (payload?: unknown) => void);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.socket.emit(event, payload);
    return true;
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}

class BrowserGameSocket implements GameSocket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, EventHandler[]>();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 8;
  private readonly reconnectDelayMs = 400;
  private closedByUser = false;

  constructor(private readonly url: string) {
    this.connect();
  }

  on<T = unknown>(event: string, handler: (payload: T) => void): GameSocket {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler as EventHandler);
    this.handlers.set(event, existing);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const message: WireMessage = { event, payload };
    this.ws.send(JSON.stringify(message));
    return true;
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.publish("connect");
    });

    ws.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as Partial<WireMessage>;
        if (!parsed?.event || typeof parsed.event !== "string") {
          return;
        }
        this.publish(parsed.event, parsed.payload);
      } catch {
        // Ignore malformed payloads from network/proxies.
      }
    });

    ws.addEventListener("close", () => {
      this.publish("disconnect");
      if (this.closedByUser) {
        return;
      }
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        return;
      }
      this.reconnectAttempts += 1;
      setTimeout(() => {
        if (!this.closedByUser) {
          this.connect();
        }
      }, this.reconnectDelayMs);
    });
  }

  private publish(event: string, payload?: unknown): void {
    const eventHandlers = this.handlers.get(event) ?? [];
    for (const handler of eventHandlers) {
      handler(payload);
    }
  }
}

const shouldUseSocketIo = (baseUrl: string): boolean => {
  if (SOCKET_TRANSPORT_MODE === "socketio") {
    return true;
  }
  if (SOCKET_TRANSPORT_MODE === "ws") {
    return false;
  }

  try {
    const normalized = baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
      ? baseUrl
      : `http://${baseUrl}`;
    const parsed = new URL(normalized);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

export const createGameSocket = (): GameSocket => {
  if (shouldUseSocketIo(DEFAULT_SOCKET_BASE)) {
    return new SocketIoGameSocket(
      io(DEFAULT_SOCKET_BASE, {
        transports: ["websocket"],
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 400
      })
    );
  }
  return new BrowserGameSocket(SOCKET_URL);
};
