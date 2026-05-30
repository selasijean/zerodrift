import { toError, type EngineErrorContext } from "./types.js";

export interface SSEClient {
  onmessage: ((event: { data: string }) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event?: any) => void) | null;
  close(): void;
}

export type SSEClientFactory = (url: string) => SSEClient;

export type SSEErrorReporter = (
  err: Error,
  context: EngineErrorContext,
) => void;

/** Either a fixed URL or a thunk re-evaluated on every (re)connect. */
export type SSEEndpoint = string | (() => string);

export const createBrowserSSEFactory =
  (init?: EventSourceInit): SSEClientFactory =>
  (url) =>
    new EventSource(url, init);

export abstract class BaseSSEConnection {
  private eventSource: SSEClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    protected url: SSEEndpoint,
    private sseClientFactory: SSEClientFactory = createBrowserSSEFactory(),
    private reportError?: SSEErrorReporter,
  ) {}

  connect() {
    this.openEventSource();
  }

  disconnect() {
    // Permanent teardown. Block any in-flight or future reconnect: a pending
    // `onerror` triggered by the close() below — or a timer already scheduled
    // before this call — must not re-open the source after the owning
    // StoreManager has torn down its Database. That post-teardown reopen is
    // what surfaces as "the database connection is closing".
    this.stopped = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource != null) {
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
      this.onClose();
    }
  }

  reconnect() {
    this.openEventSource();
  }

  get isConnected() {
    return this.eventSource != null;
  }

  /** Resolve the endpoint to a concrete string. Subclasses building dynamic
   * URLs (e.g. appending query params) must read through this instead of
   * `this.url` directly so a thunk endpoint is re-evaluated on every connect. */
  protected resolveUrl(): string {
    return typeof this.url === "function" ? this.url() : this.url;
  }

  protected buildUrl(): string {
    return this.resolveUrl();
  }

  protected abstract onMessage(data: string): void;

  protected onReconnect(): void {}
  protected onOpen(): void {}
  protected onClose(): void {}

  private openEventSource() {
    if (this.stopped) {
      return;
    }
    if (this.eventSource != null) {
      this.eventSource.close();
      this.eventSource = null;
      this.onClose();
    }

    // buildUrl() can throw when the endpoint is a thunk (e.g. cursor read
    // crashes). Catch + schedule a reconnect so a transient failure doesn't
    // permanently kill the stream.
    let url: string;
    try {
      url = this.buildUrl();
    } catch (err) {
      this.reportError?.(toError(err), {
        kind: "sseConstruction",
        url: "<endpoint-thunk-threw>",
      });
      this.scheduleReconnect();
      return;
    }

    try {
      this.eventSource = this.sseClientFactory(url);

      this.eventSource.onmessage = (e) => {
        try {
          this.onMessage(e.data);
        } catch (err) {
          this.reportError?.(toError(err), {
            kind: "ssePacketParse",
            url,
            raw: e.data,
          });
        }
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        this.onClose();
        this.scheduleReconnect();
      };

      this.onOpen();
    } catch (err) {
      this.reportError?.(toError(err), { kind: "sseConstruction", url });
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer != null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventSource();
      this.onReconnect();
    }, 3000);
  }
}
