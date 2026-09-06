/**
 * Client side of a lockstep simulation: run the same deterministic state a
 * little ahead of the server, keep a short history, and only adopt a server
 * snapshot when it disagrees with what we predicted (replaying our newer
 * inputs on top).
 */
import type { LockstepRules } from './server';

export interface PredictionRules<S extends { tick: number }, I extends { tick: number }, E> extends LockstepRules<S, I, E> {
  /** Length of one step in milliseconds. */
  stepMs: number;
  /** Whether two states agree (to floating-point noise). */
  match(a: S, b: S): boolean;
}

export class Prediction<S extends { tick: number }, I extends { tick: number }, E> {
  state: S | null = null;
  private readonly history: (S | undefined)[];
  /** Race clock estimate: raceMs ≈ performance.now() + offset, from the freshest recent snapshots. */
  private offset = -Infinity;
  private clockSamples: number[] = [];
  private pending: { input: I; sentAt: number }[] = [];

  constructor(
    private readonly rules: PredictionRules<S, I, E>,
    private readonly historySize = 96,
    private readonly pendingMs = 800,
    private readonly maxStepsPerFrame = 48,
  ) {
    this.history = new Array(historySize);
  }

  /** Feed the server's race clock; only meaningful while it's running. */
  sampleClock(raceMs: number, running: boolean): void {
    if (!running) {
      this.clockSamples = [];
      this.offset = -Infinity;
      return;
    }
    this.clockSamples.push(raceMs - performance.now());
    if (this.clockSamples.length > 20) this.clockSamples.shift();
    this.offset = Math.max(...this.clockSamples);
  }

  get tick(): number {
    return this.state?.tick ?? 0;
  }

  /** Step the predicted state up to the current race clock, reporting what happens. */
  advance(now: number, onEvent: (event: E) => void): void {
    if (!this.state || this.offset === -Infinity) return;
    const target = Math.floor((now + this.offset) / this.rules.stepMs);
    let steps = 0;
    while (this.state.tick < target && steps++ < this.maxStepsPerFrame) {
      const events: E[] = [];
      this.rules.step(this.state, events);
      this.remember(this.state);
      for (const ev of events) onEvent(ev);
    }
  }

  /** Apply an input locally now; returns it stamped with the current tick, ready to send. */
  input(make: (tick: number) => I): I | null {
    if (!this.state) return null;
    const input = make(this.state.tick);
    this.rules.apply(this.state, input);
    this.pending.push({ input, sentAt: performance.now() });
    return input;
  }

  /**
   * Adopt a server snapshot if our prediction disagrees with it, keeping our
   * newer inputs. If we had fallen behind the snapshot, the skipped steps are
   * simulated first so nothing that happened in them goes unannounced.
   */
  reconcile(snapshot: S, fixup?: (state: S) => void, onEvent?: (event: E) => void): void {
    const now = performance.now();
    this.pending = this.pending.filter((p) => now - p.sentAt < this.pendingMs);
    if (!this.state) {
      this.state = this.rules.clone(snapshot);
      this.remember(this.state);
      return;
    }
    let steps = 0;
    while (this.state.tick < snapshot.tick && steps++ < this.maxStepsPerFrame) {
      const events: E[] = [];
      this.rules.step(this.state, events);
      this.remember(this.state);
      if (onEvent) for (const ev of events) onEvent(ev);
    }
    if (snapshot.tick <= this.state.tick) {
      const ours = this.history[snapshot.tick % this.historySize];
      if (ours && ours.tick === snapshot.tick && this.rules.match(ours, snapshot)) return; // in step
    }
    // Out of step: take the server's word and replay up to where we were.
    const wasAt = this.state.tick;
    this.state = this.rules.clone(snapshot);
    fixup?.(this.state);
    this.remember(this.state);
    const replay = this.pending.map((p) => p.input).filter((i) => i.tick > snapshot.tick);
    while (this.state.tick < wasAt) {
      for (const input of replay) if (input.tick === this.state.tick) this.rules.apply(this.state, input);
      const events: E[] = [];
      this.rules.step(this.state, events);
      this.remember(this.state);
    }
  }

  private remember(s: S): void {
    this.history[s.tick % this.historySize] = this.rules.clone(s);
  }
}
