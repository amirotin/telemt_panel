// FakeEventSource stands in for the browser's EventSource: enough of the
// interface (addEventListener/removeEventListener/close/readyState/url) for
// sseClient.ts, plus test-only `emit*` helpers to drive it deterministically
// under fake timers — no real network, no jsdom EventSource dependency.
// Shared between sseClient.test.ts (the client's own unit tests) and
// context.test.tsx (the React hook layer built on top of it).
export const READY_STATE_CONNECTING = 0;
export const READY_STATE_OPEN = 1;
export const READY_STATE_CLOSED = 2;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }

  url: string;
  readyState = READY_STATE_CONNECTING;
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(cb);
  }

  close() {
    this.closed = true;
    this.readyState = READY_STATE_CLOSED;
  }

  emitOpen() {
    this.readyState = READY_STATE_OPEN;
    this.dispatch("open", {} as MessageEvent);
  }

  emitData(topic: string, v: unknown, ts: number) {
    this.dispatch(topic, { data: JSON.stringify({ v, ts }) } as MessageEvent);
  }

  emitHeartbeat() {
    this.dispatch("heartbeat", { data: "{}" } as MessageEvent);
  }

  emitSourceError(topic: string, code: string) {
    this.dispatch("source_error", { data: JSON.stringify({ topic, code }) } as MessageEvent);
  }

  emitError(readyState: number) {
    this.readyState = readyState;
    this.dispatch("error", {} as MessageEvent);
  }

  private dispatch(type: string, ev: MessageEvent) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) cb(ev);
  }
}

export function latestInstance(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1);
  if (!instance) throw new Error("no FakeEventSource created yet");
  return instance;
}

// eventSourceFactory is the createSSEClient({eventSourceFactory}) test seam,
// wired to FakeEventSource.
export function fakeEventSourceFactory(url: string): EventSource {
  return new FakeEventSource(url) as unknown as EventSource;
}
