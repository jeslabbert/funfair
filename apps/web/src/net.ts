import type { ClientMessage, ServerMessage } from '@funfair/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  /** Called on every (re)connect – re-send whatever identifies this client. */
  onOpen(): void;
}

/** Auto-reconnecting WebSocket to the funfair server on the same origin. */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private closedByUser = false;

  constructor(private readonly handlers: ConnectionHandlers) {}

  static url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(Connection.url());
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
      this.handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        console.warn('unparseable message from server', ev.data);
        return;
      }
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onStatus('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Force a fresh socket now (e.g. when the tab becomes visible again). */
  kick(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.connect();
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(8000, 300 * 2 ** this.attempt++);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
