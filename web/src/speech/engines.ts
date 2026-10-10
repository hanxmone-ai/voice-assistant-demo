import { MOCK_TRANSCRIPTS, mockStream } from '../../../shared/mock.ts';
import { readSse } from '../../../shared/sse.ts';
import { type Capabilities, type ChatMessage, STREAM_EVENT_TYPES, type StreamEvent } from '../../../shared/types.ts';
import type { ChatModel, Transcriber, Utterance } from '../assistant.ts';
import type { Playable, Synthesize } from './speech_queue.ts';

export type Lang = 'en' | 'zh';
const LOCALE: Record<Lang, string> = { en: 'en-US', zh: 'zh-CN' };

// --- Server ---------------------------------------------------------------

export async function probeServer(baseUrl: string, timeoutMs = 2500): Promise<Capabilities | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const caps = (await res.json()) as Capabilities;
    return caps.ok ? caps : null;
  } catch {
    return null;
  }
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `server returned ${res.status}`;
}

export class ServerChat implements ChatModel {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: messages.filter((m) => m.role !== 'system') }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorText(res));
    for await (const m of readSse(res.body)) {
      if ((STREAM_EVENT_TYPES as readonly string[]).includes(m.event)) yield JSON.parse(m.data) as StreamEvent;
    }
  }
}

export class ServerTranscriber implements Transcriber {
  private readonly baseUrl: string;
  private readonly lang: () => Lang;

  constructor(baseUrl: string, lang: () => Lang) {
    this.baseUrl = baseUrl;
    this.lang = lang;
  }

  async transcribe(audio: Utterance, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/transcribe?lang=${this.lang()}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: audio.wav,
      signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    return ((await res.json()) as { text: string }).text;
  }
}

/** TTS on the server: each sentence comes back as MP3 and plays through Web Audio. */
export function serverSpeech(baseUrl: string, context: () => AudioContext): Synthesize {
  return async (text, signal) => {
    const res = await fetch(`${baseUrl}/api/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    const ctx = context();
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    return {
      play: (stop) =>
        new Promise<void>((done) => {
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.onended = () => done();
          stop.addEventListener('abort', () => source.stop(), { once: true });
          source.start();
        }),
    };
  };
}

// --- Browser --------------------------------------------------------------

export function browserCanSpeak(): boolean {
  return typeof speechSynthesis !== 'undefined';
}

/** TTS with the browser's own voices (speechSynthesis). */
export function browserSpeech(lang: () => Lang): Synthesize {
  return async (text): Promise<Playable> => ({
    play: (stop) =>
      new Promise<void>((done) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = LOCALE[lang()];
        const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').startsWith(LOCALE[lang()].slice(0, 2)));
        if (voice) u.voice = voice;
        u.rate = 1.05;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(guard);
          done();
        };
        u.onend = finish;
        u.onerror = finish;
        // Some browsers never fire onend when no voice is installed.
        const guard = setTimeout(finish, 1500 + text.length * 120);
        stop.addEventListener(
          'abort',
          () => {
            speechSynthesis.cancel();
            finish();
          },
          { once: true },
        );
        speechSynthesis.speak(u);
      }),
  });
}

interface RecognitionResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionClass(): (new () => Recognition) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserCanRecognise(): boolean {
  return recognitionClass() !== null;
}

/**
 * The browser's speech recogniser (Chrome, Edge, Safari), kept running while
 * the assistant listens. It finds its own sentence ends; finals are passed on.
 */
export class BrowserRecogniser {
  private recognition: Recognition | null = null;
  private wanted = false;
  private readonly lang: () => Lang;
  private readonly onFinal: (text: string) => void;
  private readonly onInterim: (text: string) => void;
  private readonly onError: (code: string) => void;

  /** [onError] gets the recogniser's error code; recognition has stopped by then. */
  constructor(o: { lang: () => Lang; onFinal: (t: string) => void; onInterim: (t: string) => void; onError: (code: string) => void }) {
    this.lang = o.lang;
    this.onFinal = o.onFinal;
    this.onInterim = o.onInterim;
    this.onError = o.onError;
  }

  start(): void {
    this.wanted = true;
    if (this.recognition) return;
    const Ctor = recognitionClass();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = LOCALE[this.lang()];
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        if (result.isFinal) this.onFinal(result[0].transcript);
        else interim += result[0].transcript;
      }
      if (interim) this.onInterim(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      // Anything else (no network, blocked, a browser without the service)
      // won't fix itself by restarting.
      this.wanted = false;
      this.onError(e.error);
    };
    // Browsers end recognition after a while of silence; keep it going.
    r.onend = () => {
      this.recognition = null;
      if (this.wanted) setTimeout(() => this.wanted && this.start(), 250);
    };
    this.recognition = r;
    try {
      r.start();
    } catch {
      this.recognition = null;
    }
  }

  stop(): void {
    this.wanted = false;
    this.recognition?.abort();
    this.recognition = null;
  }
}

// --- Demo -----------------------------------------------------------------

export class MockChat implements ChatModel {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<StreamEvent> {
    return mockStream(messages, { signal });
  }
}

/** Without any recogniser, pretend to hear one of a few questions. */
export class MockTranscriber implements Transcriber {
  private next = 0;
  private readonly lang: () => Lang;

  constructor(lang: () => Lang) {
    this.lang = lang;
  }

  async transcribe(_audio: Utterance, signal: AbortSignal): Promise<string> {
    await new Promise((r) => setTimeout(r, 300));
    if (signal.aborted) return '';
    const list = MOCK_TRANSCRIPTS[this.lang()];
    return list[this.next++ % list.length]!;
  }
}
