import { afterEach, describe, expect, it, vi } from "vitest";

const ioMock = vi.hoisted(() =>
  vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
);

vi.mock("socket.io-client", () => ({
  io: ioMock,
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

const setEnv = (socketUrl: string, transportMode = "auto"): void => {
  process.env.NEXT_PUBLIC_SOCKET_URL = socketUrl;
  process.env.NEXT_PUBLIC_API_BASE = socketUrl;
  process.env.NEXT_PUBLIC_SOCKET_TRANSPORT = transportMode;
};

const installMockWebSocket = (onConstruct: (url: string) => void): void => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;

    constructor(url: string | URL) {
      onConstruct(String(url));
    }

    addEventListener(): void {}

    send(): void {}

    close(): void {}
  }

  vi.stubGlobal("WebSocket", MockWebSocket);
};

describe("createGameSocket transport selection", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    if (ORIGINAL_WEBSOCKET) {
      vi.stubGlobal("WebSocket", ORIGINAL_WEBSOCKET);
      return;
    }
    vi.unstubAllGlobals();
  });

  it("uses socket.io when socket host is localhost", async () => {
    let wsConstructed = false;
    installMockWebSocket(() => {
      wsConstructed = true;
    });
    setEnv("http://localhost:4000");

    const { createGameSocket } = await import("../lib/socket");
    createGameSocket();

    expect(ioMock).toHaveBeenCalledOnce();
    expect(wsConstructed).toBe(false);
  });

  it("uses websocket bridge for cloud worker URLs by default", async () => {
    let constructedUrl = "";
    installMockWebSocket((url) => {
      constructedUrl = url;
    });
    setEnv("https://kachuful-server.rdoshi13.workers.dev");

    const { createGameSocket } = await import("../lib/socket");
    createGameSocket();

    expect(ioMock).not.toHaveBeenCalled();
    expect(constructedUrl).toBe(
      "wss://kachuful-server.rdoshi13.workers.dev/ws",
    );
  });
});
