import type { ChatMessage, StreamEvent } from '../../shared/types.ts';
import { SentenceChunker } from './speech/chunker.ts';
import { SpeechQueue, type Synthesize } from './speech/speech_queue.ts';

export type AssistantState =
  /** Not listening. */
  | 'idle'
  /** Waiting for the person to speak. */
  | 'listening'
  /** The person is speaking. */
  | 'hearing'
  /** Turning speech into text. */
  | 'transcribing'
  /** Waiting for the model's first sentence. */
  | 'thinking'
  /** Talking. */
  | 'speaking';

/** An utterance recorded by the VAD. */
export interface Utterance {
  wav: Uint8Array<ArrayBuffer>;
  durationMs: number;
}

export interface Transcriber {
  transcribe(audio: Utterance, signal: AbortSignal): Promise<string>;
}

export interface ChatModel {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** How long each step of one turn took, in ms. */
export interface TurnMetrics {
  /** End of speech → transcript. */
  sttMs?: number;
  /** Transcript → first token from the model. */
  firstTokenMs?: number;
  /** Transcript → first sound. The number people feel. */
  firstAudioMs?: number;
  /** End of speech → first sound, when the turn started from speech. */
  voiceToVoiceMs?: number;
  model?: string;
}

export interface Turn {
  id: number;
  user: string;
  /** Everything the model wrote. */
  reply: string;
  /** Interrupted by the person (barge-in) or stopped. */
  interrupted: boolean;
  /**
   * For an interrupted spoken answer: how much of [reply] was heard, in
   * characters (what goes into the history). Unset when it can't be told.
   */
  heardChars?: number;
  done: boolean;
  error?: string;
  metrics: TurnMetrics;
}

export interface AssistantDeps {
  llm: ChatModel;
  /** Null when speech arrives as text (browser recognition) or there is no STT. */
  stt: Transcriber | null;
  /** Null for text-only answers. */
  tts: Synthesize | null;
  now?: () => number;
  systemPrompt?: string;
  /** How many earlier messages to send with each question. */
  historyLimit?: number;
}

type Listener = () => void;

/**
 * The conversation loop: listen → transcribe → think → speak → listen.
 *
 * Audio and UI live outside; they call [speechStarted], [speechEnded],
 * [transcript] or [sendText], and read [state] and [turns]. Speaking while
 * the assistant thinks or talks interrupts it (barge-in): the model call and
 * the speech stop at once, and only the part that was heard goes into the
 * history, so the model knows where it was cut off.
 */
export class VoiceAssistant {
  state: AssistantState = 'idle';
  readonly turns: Turn[] = [];
  lastError: string | null = null;

  private readonly history: ChatMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private current: { turn: Turn; controller: AbortController; queue: SpeechQueue | null } | null = null;
  private transcribing: AbortController | null = null;
  private speechEndedAt: number | null = null;
  private handsFree = false;
  private nextId = 1;

  private readonly deps: AssistantDeps;

  constructor(deps: AssistantDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hands-free mode: listen again after every answer. */
  start(): void {
    this.handsFree = true;
    if (this.state === 'idle') this.setState('listening');
  }

  /** Stops listening and cuts off whatever is happening. */
  stop(): void {
    this.handsFree = false;
    this.interrupt();
    this.transcribing?.abort();
    this.transcribing = null;
    this.setState('idle');
  }

  get listening(): boolean {
    return this.handsFree;
  }

  /** The VAD heard speech start. */
  speechStarted(): void {
    if (!this.handsFree) return;
    if (this.state === 'thinking' || this.state === 'speaking') this.interrupt();
    this.transcribing?.abort();
    this.transcribing = null;
    this.setState('hearing');
  }

  /** The VAD heard speech end. With an [utterance] and an STT, it is transcribed here. */
  async speechEnded(utterance: Utterance | null): Promise<void> {
    if (!this.handsFree || this.state !== 'hearing') return;
    this.speechEndedAt = this.now();
    const stt = this.deps.stt;
    if (!utterance || !stt) {
      // Text will come from a recogniser via transcript().
      this.setState('transcribing');
      return;
    }
    const controller = new AbortController();
    this.transcribing = controller;
    this.setState('transcribing');
    let text: string;
    try {
      text = (await stt.transcribe(utterance, controller.signal)).trim();
    } catch (e) {
      if (controller.signal.aborted) return;
      this.transcribing = null;
      this.fail(e);
      this.setState(this.handsFree ? 'listening' : 'idle');
      return;
    }
    if (controller.signal.aborted) return;
    this.transcribing = null;
    await this.transcript(text);
  }

  /** A final transcript (from the STT above or a browser recogniser). */
  async transcript(text: string): Promise<void> {
    const sttMs = this.speechEndedAt == null ? undefined : this.now() - this.speechEndedAt;
    const endedAt = this.speechEndedAt;
    this.speechEndedAt = null;
    if (!text.trim()) {
      // Nothing understood (a cough, a door): keep listening.
      this.setState(this.handsFree ? 'listening' : 'idle');
      return;
    }
    await this.run(text.trim(), { sttMs, endedAt });
  }

  /** A typed question. */
  async sendText(text: string): Promise<void> {
    if (!text.trim()) return;
    this.interrupt();
    this.speechEndedAt = null;
    await this.run(text.trim(), {});
  }

  /** Stops the current answer (barge-in, the stop button, a new question). */
  interrupt(): void {
    const c = this.current;
    if (!c) return;
    c.turn.interrupted = !c.turn.done;
    c.controller.abort();
    c.queue?.stop();
  }

  private async run(text: string, origin: { sttMs?: number; endedAt?: number | null }): Promise<void> {
    this.interrupt();
    const turn: Turn = { id: this.nextId++, user: text, reply: '', interrupted: false, done: false, metrics: {} };
    if (origin.sttMs !== undefined) turn.metrics.sttMs = Math.round(origin.sttMs);
    const controller = new AbortController();
    const started = this.now();
    const tts = this.deps.tts;
    const queue = tts
      ? new SpeechQueue(tts, {
          onFirstAudio: () => {
            turn.metrics.firstAudioMs = Math.round(this.now() - started);
            if (origin.endedAt != null) turn.metrics.voiceToVoiceMs = Math.round(this.now() - origin.endedAt);
            if (this.current?.turn === turn) this.setState('speaking');
          },
          onError: (e) => this.fail(e),
        })
      : null;
    const me = { turn, controller, queue };
    this.current = me;
    this.turns.push(turn);
    this.lastError = null;
    this.setState('thinking');

    const messages: ChatMessage[] = [
      ...(this.deps.systemPrompt ? [{ role: 'system' as const, content: this.deps.systemPrompt }] : []),
      ...this.history.slice(-(this.deps.historyLimit ?? 12)),
      { role: 'user', content: text },
    ];
    const chunker = new SentenceChunker();
    try {
      for await (const event of this.deps.llm.stream(messages, controller.signal)) {
        if (controller.signal.aborted) break;
        if (event.type === 'start') turn.metrics.model = event.model;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type !== 'delta') continue;
        turn.metrics.firstTokenMs ??= Math.round(this.now() - started);
        turn.reply += event.text;
        for (const sentence of chunker.push(event.text)) queue?.enqueue(sentence);
        if (!queue && this.state === 'thinking') this.setState('speaking');
        this.emit();
      }
      if (!controller.signal.aborted) {
        for (const sentence of chunker.flush()) queue?.enqueue(sentence);
        await queue?.done();
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        turn.error = e instanceof Error ? e.message : String(e);
        this.fail(e);
      }
    } finally {
      turn.done = true;
      // Remember what the person actually heard when they cut in.
      const heard = turn.interrupted && queue ? queue.spoken.join(' ') : turn.reply;
      if (turn.interrupted && queue) {
        const end = heardUpTo(turn.reply, queue.spoken);
        if (end !== null) turn.heardChars = end;
      }
      this.history.push({ role: 'user', content: text });
      if (heard.trim()) this.history.push({ role: 'assistant', content: turn.interrupted ? `${heard} …` : heard });
      if (this.current === me) {
        this.current = null;
        if (this.state === 'thinking' || this.state === 'speaking') this.setState(this.handsFree ? 'listening' : 'idle');
      }
      this.emit();
    }
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.emit();
  }

  private setState(s: AssistantState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Where the [spoken] sentences end in [reply], or null if they can't all be found (Markdown was removed for speech). */
export function heardUpTo(reply: string, spoken: readonly string[]): number | null {
  let end = 0;
  for (const sentence of spoken) {
    const at = reply.indexOf(sentence, end);
    if (at < 0) return null;
    end = at + sentence.length;
  }
  return end;
}
