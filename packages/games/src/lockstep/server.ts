/**
 * Server side of a lockstep simulation: a deterministic state stepped at a
 * fixed rate, inputs stamped with the tick they happened on, and enough
 * history to rewind and apply a late input at its real tick.
 */

export interface LockstepRules<S extends { tick: number }, I extends { tick: number }, E> {
  /** Advance the state by one step (tick + 1), reporting what happened. */
  step(state: S, events: E[]): void;
  clone(state: S): S;
  /** Apply an input to the state at its current tick, reporting what it caused. */
  apply(state: S, input: I, events: E[]): void;
}

export class LockstepSim<S extends { tick: number }, I extends { tick: number }, E> {
  state: S;
  private readonly history: (S | undefined)[];
  private readonly size: number;
  /** Inputs arrive in tick order; a later one can't rewind past an earlier one. */
  private lastInputTick = -1;
  /** Never rewind past this (something scored or otherwise can't be undone). */
  private barrierTick = -1;
  /** Inputs stamped a little ahead of the state, applied when their tick comes. */
  private queued: I[] = [];

  constructor(
    private readonly rules: LockstepRules<S, I, E>,
    initial: S,
    readonly maxRewind: number,
  ) {
    this.state = initial;
    this.size = maxRewind + 4;
    this.history = new Array(this.size);
  }

  /** Nothing before this tick can be revisited. */
  barrier(tick: number): void {
    this.barrierTick = Math.max(this.barrierTick, tick);
  }

  /** Step up to `tick`, reporting events as they happen. */
  advanceTo(tick: number, onEvent: (event: E) => void): void {
    while (this.state.tick < tick) this.stepOne(onEvent);
  }

  /** Apply an input at the tick it happened, within reason. */
  input(input: I, onEvent: (event: E) => void): void {
    const now = this.state.tick;
    const wanted = Math.floor(input.tick);
    if (wanted > now) {
      // A client running a little ahead of us: hold the input for its tick.
      const at = Math.min(wanted, now + this.maxRewind);
      this.queued.push({ ...input, tick: at });
      this.queued.sort((a, b) => a.tick - b.tick);
      return;
    }
    let at = Math.max(now - this.maxRewind, wanted);
    at = Math.max(at, this.lastInputTick, this.barrierTick);
    if (at < now) {
      const past = this.history[at % this.size];
      if (past && past.tick === at) this.state = this.rules.clone(past);
      else at = now;
    }
    this.lastInputTick = at;
    const events: E[] = [];
    this.rules.apply(this.state, input, events);
    for (const ev of events) onEvent(ev);
    // Bring the state back up to date; anything that happens on the way counts as usual.
    this.advanceTo(now, onEvent);
  }

  private stepOne(onEvent: (event: E) => void): void {
    // Inputs whose tick has come go in before this step.
    while (this.queued.length && this.queued[0]!.tick <= this.state.tick) {
      const input = this.queued.shift()!;
      this.lastInputTick = Math.max(this.lastInputTick, this.state.tick);
      const inputEvents: E[] = [];
      this.rules.apply(this.state, input, inputEvents);
      for (const ev of inputEvents) onEvent(ev);
    }
    const events: E[] = [];
    this.rules.step(this.state, events);
    this.history[this.state.tick % this.size] = this.rules.clone(this.state);
    for (const ev of events) onEvent(ev);
  }
}
