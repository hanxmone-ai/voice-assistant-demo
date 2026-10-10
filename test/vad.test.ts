import { describe, expect, it } from 'vitest';

import { levelDb, UtteranceRecorder, Vad } from '../web/src/audio/vad.ts';
import { decodeWavInfo, encodeWav, resample } from '../shared/wav.ts';

const RATE = 16000;
const FRAME = 320; // 20 ms

/** A frame of noise at about [db] dBFS, or a tone ("speech") at that level. */
function frame(db: number, tone = false, phase = 0): Float32Array {
  const amp = 10 ** (db / 20) * Math.SQRT2;
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    f[i] = tone ? amp * Math.sin((2 * Math.PI * 220 * (phase + i)) / RATE) : amp * (Math.random() * 2 - 1) * 0.87;
  }
  return f;
}

function run(vad: Vad, frames: Float32Array[]): { event: string; ms: number }[] {
  const events: { event: string; ms: number }[] = [];
  frames.forEach((f, i) => {
    const e = vad.process(f);
    if (e) events.push({ event: e, ms: (i + 1) * 20 });
  });
  return events;
}

const repeat = (n: number, make: (i: number) => Float32Array) => Array.from({ length: n }, (_, i) => make(i));

describe('levelDb', () => {
  it('measures RMS in dBFS', () => {
    expect(levelDb(frame(-20, true))).toBeCloseTo(-20, 0);
    expect(levelDb(new Float32Array(FRAME))).toBeLessThan(-150);
  });
});

describe('Vad', () => {
  it('detects speech after minSpeechMs and its end after the hangover', () => {
    const vad = new Vad({ sampleRate: RATE });
    const frames = [
      ...repeat(50, () => frame(-60)), // 1 s of room noise
      ...repeat(40, (i) => frame(-25, true, i * FRAME)), // 800 ms of speech
      ...repeat(50, () => frame(-60)), // silence
    ];
    const events = run(vad, frames);
    expect(events.map((e) => e.event)).toEqual(['start', 'end']);
    expect(events[0]!.ms).toBe(1000 + 120); // minSpeechMs after onset
    expect(events[1]!.ms).toBe(1800 + 660); // hangover after offset (rounded to frames)
  });

  it('ignores short clicks and pauses inside a sentence', () => {
    const vad = new Vad({ sampleRate: RATE });
    const frames = [
      ...repeat(50, () => frame(-60)),
      ...repeat(3, (i) => frame(-20, true, i * FRAME)), // 60 ms click
      ...repeat(20, () => frame(-60)),
      ...repeat(25, (i) => frame(-25, true, i * FRAME)),
      ...repeat(15, () => frame(-60)), // 300 ms pause between words
      ...repeat(25, (i) => frame(-25, true, i * FRAME)),
      ...repeat(50, () => frame(-60)),
    ];
    expect(run(vad, frames).map((e) => e.event)).toEqual(['start', 'end']);
  });

  it('adapts to a noisy room instead of treating it as speech', () => {
    const vad = new Vad({ sampleRate: RATE });
    // A fan spins up to a steady -40 dB, in steps smaller than the speech
    // threshold. The floor follows it slowly.
    const events = run(vad, [...repeat(50, () => frame(-60)), ...repeat(250, () => frame(-50)), ...repeat(250, () => frame(-40))]);
    expect(events).toEqual([]);
    expect(vad.floorDb).toBeGreaterThan(-44);
    // Speech over the fan is still heard.
    expect(run(vad, repeat(20, (i) => frame(-18, true, i * FRAME))).map((e) => e.event)).toEqual(['start']);
  });

  it('a stricter threshold (while the assistant talks) needs louder speech', () => {
    const vad = new Vad({ sampleRate: RATE, startDb: 30 });
    const quiet = run(vad, [...repeat(50, () => frame(-60)), ...repeat(20, (i) => frame(-40, true, i * FRAME))]);
    expect(quiet).toEqual([]);
  });
});

describe('UtteranceRecorder', () => {
  it('keeps the pre-roll so the first syllable is not lost', () => {
    const rec = new UtteranceRecorder(RATE, { preRollMs: 100 });
    for (let i = 0; i < 20; i++) rec.push(new Float32Array(FRAME).fill(i));
    rec.start();
    rec.push(new Float32Array(FRAME).fill(99));
    const out = rec.stop();
    // 100 ms = 1600 samples = 5 frames of pre-roll, plus the recorded frame.
    expect(out.length).toBe(6 * FRAME);
    expect(out[0]).toBe(15);
    expect(out[out.length - 1]).toBe(99);
    expect(rec.isRecording).toBe(false);
  });

  it('caps the length', () => {
    const rec = new UtteranceRecorder(RATE, { preRollMs: 0, maxMs: 100 });
    rec.start();
    for (let i = 0; i < 50; i++) rec.push(new Float32Array(FRAME));
    expect(rec.stop().length).toBeLessThanOrEqual(1600 + FRAME);
  });
});

describe('wav', () => {
  it('encodes 16-bit mono and reads back', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const wav = encodeWav(samples, 16000);
    expect(wav.length).toBe(44 + 12);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44 + 2, true)).toBe(16383);
    expect(view.getInt16(44 + 8, true)).toBe(-32768);
    expect(view.getInt16(44 + 10, true)).toBe(32767);
    expect(decodeWavInfo(wav)).toEqual({ sampleRate: 16000, channels: 1, bits: 16, durationMs: 0.375 });
    expect(() => decodeWavInfo(new Uint8Array(10))).toThrow();
  });

  it('resamples 48 kHz to 16 kHz', () => {
    const one = new Float32Array(48000).fill(0.25);
    const out = resample(one, 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.25);
    expect(resample(one, 16000, 16000)).toBe(one);
  });
});
