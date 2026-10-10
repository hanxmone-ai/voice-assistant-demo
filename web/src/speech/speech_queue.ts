/** Something ready to be heard: a decoded audio clip, or a browser utterance. */
export interface Playable {
  /** Plays to the end; returns early (without throwing) when [signal] aborts. */
  play(signal: AbortSignal): Promise<void>;
}

export type Synthesize = (text: string, signal: AbortSignal) => Promise<Playable>;

/**
 * Speaks sentences in order while later ones are still being synthesised.
 *
 * Synthesis of a sentence starts as soon as it is queued, so by the time the
 * first sentence has been heard, the second is usually ready: the gap
 * between sentences is the playback time, not the TTS round trip.
 */
export class SpeechQueue {
  private readonly controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private readonly spokenParts: string[] = [];
  private failures = 0;

  private readonly synthesize: Synthesize;
  private readonly hooks: { onFirstAudio?: () => void; onError?: (e: unknown) => void };

  constructor(synthesize: Synthesize, hooks: { onFirstAudio?: () => void; onError?: (e: unknown) => void } = {}) {
    this.synthesize = synthesize;
    this.hooks = hooks;
  }

  /** Sentences heard to the end, in order. */
  get spoken(): readonly string[] {
    return this.spokenParts;
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  enqueue(text: string): void {
    if (this.stopped || !text.trim()) return;
    const signal = this.controller.signal;
    const clip = this.synthesize(text, signal).catch((e: unknown) => {
      if (!signal.aborted) {
        this.failures++;
        this.hooks.onError?.(e);
      }
      return null;
    });
    this.tail = this.tail.then(async () => {
      if (signal.aborted) return;
      const playable = await clip;
      if (!playable || signal.aborted) return;
      if (!this.started) {
        this.started = true;
        this.hooks.onFirstAudio?.();
      }
      try {
        await playable.play(signal);
      } catch (e) {
        if (!signal.aborted) this.hooks.onError?.(e);
        return;
      }
      if (!signal.aborted) this.spokenParts.push(text);
    });
  }

  /** Resolves when everything queued so far has played, or the queue was stopped. */
  done(): Promise<void> {
    return this.tail;
  }

  /** Stops the current sentence and drops the rest. */
  stop(): void {
    this.controller.abort();
  }
}
