/**
 * Energy-based voice activity detection with an adaptive noise floor.
 *
 * Speech starts when the level stays [startDb] above the background for
 * [minSpeechMs], and ends after [hangoverMs] below [stopDb] above it. The
 * background level follows the room while nobody is talking (fast down,
 * slow up), so a fan or a café doesn't count as speech. Small and
 * dependency-free; a neural VAD (Silero, WebRTC) is more robust in very noisy
 * places and can replace it behind the same events.
 */

export type VadEvent = 'start' | 'end';

export interface VadOptions {
  sampleRate: number;
  /** dB above the noise floor that counts as speech. */
  startDb?: number;
  /** dB above the noise floor below which speech is over. */
  stopDb?: number;
  minSpeechMs?: number;
  hangoverMs?: number;
  /** The floor never goes below this, so digital silence isn't "very quiet". */
  minFloorDb?: number;
  initialFloorDb?: number;
}

export class Vad {
  readonly sampleRate: number;
  /** Adjustable: raised while the assistant talks so its own voice is not taken for speech. */
  startDb: number;
  readonly stopDb: number;
  readonly minSpeechMs: number;
  readonly hangoverMs: number;
  readonly minFloorDb: number;

  /** Background level in dBFS. */
  floorDb: number;
  /** Level of the last frame in dBFS. */
  levelDb = -100;
  speaking = false;

  private voicedMs = 0;
  private silentMs = 0;

  constructor(o: VadOptions) {
    this.sampleRate = o.sampleRate;
    this.startDb = o.startDb ?? 14;
    this.stopDb = o.stopDb ?? 8;
    this.minSpeechMs = o.minSpeechMs ?? 120;
    this.hangoverMs = o.hangoverMs ?? 650;
    this.minFloorDb = o.minFloorDb ?? -65;
    this.floorDb = o.initialFloorDb ?? -55;
  }

  /** Feeds one frame of mono samples (-1..1); returns an event when speech starts or ends. */
  process(frame: Float32Array): VadEvent | null {
    const ms = (frame.length / this.sampleRate) * 1000;
    this.levelDb = levelDb(frame);
    const above = this.levelDb - this.floorDb;

    if (!this.speaking) {
      if (above >= this.startDb) {
        this.voicedMs += ms;
        if (this.voicedMs >= this.minSpeechMs) {
          this.speaking = true;
          this.voicedMs = 0;
          this.silentMs = 0;
          return 'start';
        }
      } else {
        this.voicedMs = 0;
        // Track the room: quickly towards quieter, slowly towards louder.
        const rate = this.levelDb < this.floorDb ? 0.3 : 0.02;
        this.floorDb = Math.max(this.minFloorDb, this.floorDb + (this.levelDb - this.floorDb) * rate);
      }
      return null;
    }

    if (above < this.stopDb) {
      this.silentMs += ms;
      if (this.silentMs >= this.hangoverMs) {
        this.speaking = false;
        this.silentMs = 0;
        return 'end';
      }
    } else {
      this.silentMs = 0;
    }
    return null;
  }

  /** Forgets the current utterance (for example after a barge-in was handled). */
  reset(): void {
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
  }
}

/** RMS level in dBFS (0 is full scale). */
export function levelDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return 20 * Math.log10(rms + 1e-9);
}

/**
 * Collects the audio of one utterance, including [preRollMs] from before the
 * VAD fired, so the first syllable isn't cut off.
 */
export class UtteranceRecorder {
  private readonly preRollSamples: number;
  private readonly maxSamples: number;
  private ring: Float32Array[] = [];
  private ringSamples = 0;
  private recording: Float32Array[] | null = null;
  private recorded = 0;

  readonly sampleRate: number;

  constructor(sampleRate: number, { preRollMs = 300, maxMs = 30000 }: { preRollMs?: number; maxMs?: number } = {}) {
    this.sampleRate = sampleRate;
    this.preRollSamples = Math.round((preRollMs / 1000) * sampleRate);
    this.maxSamples = Math.round((maxMs / 1000) * sampleRate);
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  push(frame: Float32Array): void {
    const copy = new Float32Array(frame);
    if (this.recording) {
      if (this.recorded < this.maxSamples) {
        this.recording.push(copy);
        this.recorded += copy.length;
      }
      return;
    }
    this.ring.push(copy);
    this.ringSamples += copy.length;
    while (this.ring.length > 1 && this.ringSamples - this.ring[0]!.length >= this.preRollSamples) {
      this.ringSamples -= this.ring.shift()!.length;
    }
  }

  start(): void {
    this.recording = [...this.ring];
    this.recorded = this.ringSamples;
    this.ring = [];
    this.ringSamples = 0;
  }

  /** Ends the utterance and returns its samples. */
  stop(): Float32Array {
    const parts = this.recording ?? [];
    this.recording = null;
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  cancel(): void {
    this.recording = null;
  }
}
