/**
 * A signal that gates whether a read hook is allowed to *start* fetching. Flip
 * it on and off as many times as needed and any hook handed the gate holds or
 * resumes its backfill to match. It only suppresses *new* fetches; in-flight
 * requests run to completion.
 *
 * Construct one, pass it to as many hooks as you like, and drive it from
 * whatever signal you want — an `IntersectionObserver` (don't fetch off-screen),
 * focus, route changes, a feature flag:
 *
 *     const gate = new FetchGate(false);
 *     useRecord(store.issue, id, { gate });
 *     // …from an IntersectionObserver callback the caller owns:
 *     gate.set(entry.isIntersecting);
 */
export class FetchGate {
  private _enabled: boolean;
  private readonly listeners = new Set<() => void>();

  /** @param enabled initial state — `true` allows fetching, `false` holds it. */
  constructor(enabled = true) {
    this._enabled = enabled;
  }

  /** `true` when fetching is allowed. Read by the hooks each render. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Flip the gate. Notifies subscribers only on an actual change. */
  set(enabled: boolean): void {
    if (this._enabled === enabled) {
      return;
    }
    this._enabled = enabled;
    for (const listener of this.listeners) {
      listener();
    }
  }

  enable(): void {
    this.set(true);
  }

  disable(): void {
    this.set(false);
  }

  /** Subscribe to flips. Returns an unsubscribe fn — wired into the hooks'
   * `useSyncExternalStore` so a flip re-renders the consumer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
