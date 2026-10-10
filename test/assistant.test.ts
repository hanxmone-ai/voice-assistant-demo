import { describe, expect, it } from 'vitest';

import type { ChatMessage, StreamEvent } from '../shared/types.ts';
import { type AssistantState, type ChatModel, heardUpTo, VoiceAssistant } from '../web/src/assistant.ts';
import { type Playable, SpeechQueue } from '../web/src/speech/speech_queue.ts';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** A model that streams [reply] in pieces, waiting [gap] ms between them. */
function model(reply: string, gap = 2, seen: ChatMessage[][] = []): ChatModel {
  return {
    async *stream(messages, signal): AsyncIterable<StreamEvent> {
      seen.push(messages);
      yield { type: 'start', provider: 'fake', model: 'fake-1' };
      for (const word of reply.match(/\S+\s*/g) ?? []) {
        await tick(gap);
        if (signal.aborted) return;
        yield { type: 'delta', text: word };
      }
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** TTS that takes [synthMs] to prepare and [playMs] to play each sentence; logs what happens. */
function tts(log: string[], synthMs = 5, playMs = 10) {
  return async (text: string, signal: AbortSignal): Promise<Playable> => {
    log.push(`synth:${text}`);
    await tick(synthMs);
    return {
      async play(s: AbortSignal) {
        log.push(`play:${text}`);
        for (let t = 0; t < playMs && !s.aborted; t += 2) await tick(2);
        log.push(s.aborted ? `cut:${text}` : `end:${text}`);
      },
    };
  };
}

function states(a: VoiceAssistant): AssistantState[] {
  const out: AssistantState[] = [];
  a.onChange(() => {
    if (out.at(-1) !== a.state) out.push(a.state);
  });
  return out;
}

describe('SpeechQueue', () => {
  it('synthesises ahead but plays in order', async () => {
    const log: string[] = [];
    let first = 0;
    const q = new SpeechQueue(tts(log, 5, 10), { onFirstAudio: () => first++ });
    q.enqueue('One.');
    q.enqueue('Two.');
    q.enqueue('Three.');
    expect(log).toEqual(['synth:One.', 'synth:Two.', 'synth:Three.']);
    await q.done();
    expect(log.slice(3)).toEqual(['play:One.', 'end:One.', 'play:Two.', 'end:Two.', 'play:Three.', 'end:Three.']);
    expect(first).toBe(1);
    expect(q.spoken).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('stop cuts the current sentence and drops the rest', async () => {
    const log: string[] = [];
    const q = new SpeechQueue(tts(log, 1, 30));
    q.enqueue('One.');
    q.enqueue('Two.');
    await tick(10);
    q.stop();
    await q.done();
    expect(log).toContain('cut:One.');
    expect(log).not.toContain('play:Two.');
    expect(q.spoken).toEqual([]);
    q.enqueue('Three.');
    expect(log).not.toContain('synth:Three.');
  });

  it('a sentence that fails to synthesise is skipped', async () => {
    const errors: unknown[] = [];
    const log: string[] = [];
    const ok = tts(log, 1, 2);
    const q = new SpeechQueue(
      (text, signal) => (text === 'Bad.' ? Promise.reject(new Error('quota')) : ok(text, signal)),
      { onError: (e) => errors.push(e) },
    );
    q.enqueue('Good.');
    q.enqueue('Bad.');
    q.enqueue('Fine.');
    await q.done();
    expect(q.spoken).toEqual(['Good.', 'Fine.']);
    expect(errors).toHaveLength(1);
  });
});

describe('VoiceAssistant', () => {
  const reply = 'Sure, here is the first sentence. And here comes a second one. Finally a third.';

  it('runs a spoken turn: transcribe, think, speak, listen again, with timings', async () => {
    const log: string[] = [];
    let clock = 0;
    const a = new VoiceAssistant({
      llm: model(reply),
      stt: {
        async transcribe() {
          clock += 300;
          return 'tell me something';
        },
      },
      tts: tts(log),
      now: () => clock,
    });
    const seen = states(a);
    a.start();
    a.speechStarted();
    await a.speechEnded({ wav: new Uint8Array(44), durationMs: 900 });
    expect(seen).toEqual(['listening', 'hearing', 'transcribing', 'thinking', 'speaking', 'listening']);
    const turn = a.turns[0]!;
    expect(turn.user).toBe('tell me something');
    expect(turn.reply).toBe(reply);
    expect(turn.interrupted).toBe(false);
    expect(turn.metrics.sttMs).toBe(300);
    expect(turn.metrics.model).toBe('fake-1');
    expect(log.filter((l) => l.startsWith('end:'))).toEqual([
      'end:Sure, here is the first sentence.',
      'end:And here comes a second one.',
      'end:Finally a third.',
    ]);
  });

  it('starts speaking before the model has finished', async () => {
    const log: string[] = [];
    const a = new VoiceAssistant({ llm: model(reply, 8), stt: null, tts: tts(log, 1, 1) });
    const done = a.sendText('go');
    await tick(60);
    // The first sentence is out while words of the third are still arriving.
    expect(log).toContain('play:Sure, here is the first sentence.');
    expect(a.turns[0]!.reply).not.toBe(reply);
    await done;
  });

  it('barge-in: speaking over the answer stops it, and history keeps only what was heard', async () => {
    const log: string[] = [];
    const seen: ChatMessage[][] = [];
    const a = new VoiceAssistant({ llm: model(reply, 1, seen), stt: null, tts: tts(log, 1, 40) });
    a.start();
    const first = a.transcript('long answer please');
    // Wait until the first sentence is being played, then talk.
    for (let i = 0; i < 100 && !log.some((l) => l.startsWith('play:')); i++) await tick(2);
    a.speechStarted();
    expect(a.state).toBe('hearing');
    await first;
    expect(a.turns[0]!.interrupted).toBe(true);
    await tick(5); // the speaker stops on its next audio frame
    expect(log.some((l) => l.startsWith('cut:'))).toBe(true);
    expect(log).not.toContain('play:Finally a third.');

    // The next question carries the interrupted answer as heard (nothing finished playing).
    await a.speechEnded(null);
    expect(a.state).toBe('transcribing');
    await a.transcript('and then?');
    const history = seen[1]!;
    expect(history.map((m) => m.role)).toEqual(['user', 'user']);
    expect(history.at(-1)!.content).toBe('and then?');
  });

  it('an interrupted answer that was partly heard is remembered up to that point', async () => {
    const log: string[] = [];
    const seen: ChatMessage[][] = [];
    const a = new VoiceAssistant({ llm: model(reply, 1, seen), stt: null, tts: tts(log, 1, 6) });
    a.start();
    const first = a.transcript('go');
    for (let i = 0; i < 200 && !log.includes('play:And here comes a second one.'); i++) await tick(1);
    a.speechStarted();
    await first;
    expect(a.turns[0]!.reply.slice(0, a.turns[0]!.heardChars)).toBe('Sure, here is the first sentence.');
    await a.transcript('stop there');
    expect(seen[1]![1]).toEqual({ role: 'assistant', content: 'Sure, here is the first sentence. …' });
  });

  it('empty transcripts (a cough) go back to listening', async () => {
    const a = new VoiceAssistant({ llm: model(reply), stt: { transcribe: async () => '  ' }, tts: null });
    a.start();
    a.speechStarted();
    await a.speechEnded({ wav: new Uint8Array(44), durationMs: 200 });
    expect(a.state).toBe('listening');
    expect(a.turns).toHaveLength(0);
  });

  it('STT and model errors are reported and listening goes on', async () => {
    const a = new VoiceAssistant({
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'error', message: 'quota exceeded' };
        },
      },
      stt: {
        async transcribe() {
          throw new Error('stt down');
        },
      },
      tts: null,
    });
    a.start();
    a.speechStarted();
    await a.speechEnded({ wav: new Uint8Array(44), durationMs: 200 });
    expect(a.lastError).toBe('stt down');
    expect(a.state).toBe('listening');
    await a.transcript('hello');
    expect(a.lastError).toBe('quota exceeded');
    expect(a.turns[0]!.error).toBe('quota exceeded');
    expect(a.state).toBe('listening');
  });

  it('text only (no TTS): typed questions and stop()', async () => {
    const a = new VoiceAssistant({ llm: model(reply, 3), stt: null, tts: null });
    const p = a.sendText('hi');
    await tick(10);
    expect(a.state).toBe('speaking');
    a.stop();
    await p;
    expect(a.state).toBe('idle');
    expect(a.turns[0]!.interrupted).toBe(true);
  });

  it('first-audio and voice-to-voice timings', async () => {
    let clock = 1000;
    const a = new VoiceAssistant({
      llm: model('A complete first sentence here. Then more.', 0),
      stt: {
        async transcribe() {
          clock += 250;
          return 'q';
        },
      },
      tts: async () => {
        clock += 400;
        return { play: async () => undefined };
      },
      now: () => clock,
    });
    a.start();
    a.speechStarted();
    await a.speechEnded({ wav: new Uint8Array(44), durationMs: 500 });
    const m = a.turns[0]!.metrics;
    expect(m.sttMs).toBe(250);
    expect(m.firstAudioMs).toBeGreaterThanOrEqual(400);
    expect(m.voiceToVoiceMs).toBe(m.sttMs! + m.firstAudioMs!);
  });
});

describe('heardUpTo', () => {
  it('finds the end of the spoken sentences in the written reply', () => {
    expect(heardUpTo('One. Two. Three.', ['One.', 'Two.'])).toBe(9);
    expect(heardUpTo('One. Two.', [])).toBe(0);
    expect(heardUpTo('**Bold** start. Next.', ['Bold start.'])).toBeNull();
  });
});
