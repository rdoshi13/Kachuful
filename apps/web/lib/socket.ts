type EventHandler = (payload?: unknown) => void;

const DEFAULT_HTTP_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";
const DEFAULT_SOCKET_BASE = process.env.NEXT_PUBLIC_SOCKET_URL ?? DEFAULT_HTTP_BASE;

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

export const createGameSocket = (): GameSocket => new BrowserGameSocket(SOCKET_URL);
