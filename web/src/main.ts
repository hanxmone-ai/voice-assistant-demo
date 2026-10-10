import './styles.css';

import { MOCK_TRANSCRIPTS } from '../../shared/mock.ts';
import { encodeWav, resample } from '../../shared/wav.ts';
import { VoiceAssistant, type ChatModel, type Transcriber, type Turn, type TurnMetrics } from './assistant.ts';
import { Microphone } from './audio/mic.ts';
import { UtteranceRecorder, Vad } from './audio/vad.ts';
import { loadSettings, saveSettings, type Mode, type Settings } from './settings.ts';
import {
  BrowserRecogniser,
  browserCanRecognise,
  browserCanSpeak,
  browserSpeech,
  MockChat,
  MockTranscriber,
  probeServer,
  ServerChat,
  serverSpeech,
  ServerTranscriber,
  type Lang,
} from './speech/engines.ts';
import type { Synthesize } from './speech/speech_queue.ts';

/** Speech-to-text models expect 16 kHz. */
const STT_RATE = 16000;
const START_DB = 14;
/** While the assistant talks through speakers, some of its voice gets past echo cancellation. */
const SPEAKER_START_DB = 20;
/** How long to wait for the browser recogniser's last words after speech ends. */
const RECOGNISER_GRACE_MS = 2500;

/** Where the words come from: the server's STT, the browser's recogniser, or canned demo transcripts. */
type Hearing = 'server' | 'browser' | 'demo';

interface Engines {
  llm: ChatModel;
  stt: Transcriber;
  tts: Synthesize | null;
  hearing: Hearing;
  /** Answers play through Web Audio, which needs a tap to start. */
  serverVoice: boolean;
  status: { text: string; kind: 'server' | 'demo' | 'error' };
  model: string;
  voice: string;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const orb = $<HTMLButtonElement>('#orb');
const stateLabel = $<HTMLElement>('#state-label');
const hint = $<HTMLElement>('#hint');
const caption = $<HTMLElement>('#caption');
const notice = $<HTMLElement>('#notice');
const status = $<HTMLElement>('#status');
const list = $<HTMLElement>('#turns');
const form = $<HTMLFormElement>('#composer');
const input = $<HTMLInputElement>('#input');
const dialog = $<HTMLDialogElement>('#settings');

let settings = loadSettings();
let engines: Engines;
let assistant: VoiceAssistant;
/** False until the first server check is done; taps before that are ignored. */
let ready = false;
let unsubscribe = () => {};
let shownError: string | null = null;

let mic: Microphone | null = null;
let vad: Vad | null = null;
let recorder: UtteranceRecorder | null = null;
let recogniser: BrowserRecogniser | null = null;
let output: AudioContext | null = null;

// What the browser recogniser has heard of the current utterance.
let heard = '';
let interim = '';
let graceTimer: ReturnType<typeof setTimeout> | undefined;
// Some browsers have a recogniser that never answers (no speech service, headless).
let recogniserResults = 0;
let unansweredUtterances = 0;

const lang = (): Lang => settings.lang;

// --- Engines ---------------------------------------------------------------

function serverUrl(mode: Mode, url: string): string {
  return mode === 'server' ? url.trim().replace(/\/+$/, '') : '';
}

function outputContext(): AudioContext {
  output ??= new AudioContext();
  return output;
}

async function chooseEngines(s: Settings): Promise<Engines> {
  const url = serverUrl(s.mode, s.serverUrl);
  const caps = s.mode === 'demo' ? null : await probeServer(url);

  let hearing: Hearing = 'demo';
  if (caps?.stt) hearing = 'server';
  else if (browserCanRecognise()) hearing = 'browser';

  let tts: Synthesize | null = null;
  let voice = 'none (text only)';
  if (s.speak && caps?.tts) {
    tts = serverSpeech(url, outputContext);
    voice = 'server text-to-speech';
  } else if (s.speak && browserCanSpeak()) {
    tts = browserSpeech(lang);
    voice = "the browser's voice";
  }

  let status: Engines['status'];
  if (caps) status = { text: caps.llm === 'mock' ? 'Server · mock model' : `Server · ${caps.model}`, kind: 'server' };
  else if (s.mode === 'server') status = { text: 'Server unreachable · demo', kind: 'error' };
  else status = { text: 'Demo mode', kind: 'demo' };

  return {
    llm: caps ? new ServerChat(url) : new MockChat(),
    // Also the fallback when the browser recogniser turns out not to work.
    stt: caps?.stt ? new ServerTranscriber(url, lang) : new MockTranscriber(lang),
    tts,
    hearing,
    serverVoice: tts !== null && caps?.tts === true,
    status,
    model: caps ? caps.model : 'demo mock model',
    voice,
  };
}

function hearingLabel(h: Hearing): string {
  return { server: 'server speech-to-text', browser: "the browser's speech recognition", demo: 'simulated transcripts (demo)' }[h];
}

async function configure(): Promise<void> {
  stopListening();
  status.textContent = 'Connecting…';
  status.dataset.kind = 'pending';
  engines = await chooseEngines(settings);
  status.textContent = engines.status.text;
  status.dataset.kind = engines.status.kind;
  unsubscribe();
  assistant = new VoiceAssistant({ llm: engines.llm, stt: engines.stt, tts: engines.tts });
  unsubscribe = assistant.onChange(schedule);
  shownError = null;
  showNotice(null);
  ready = true;
  schedule();
}

// --- Microphone, VAD and recognition -----------------------------------------

function onFrame(frame: Float32Array): void {
  if (!vad || !recorder || !mic) return;
  vad.startDb = assistant.state === 'speaking' && !settings.headphones ? SPEAKER_START_DB : START_DB;
  recorder.push(frame);
  const event = vad.process(frame);
  setLevel(vad.speaking || vad.levelDb - vad.floorDb > 6 ? (vad.levelDb - vad.floorDb) / 30 : 0);

  if (event === 'start') {
    clearTimeout(graceTimer);
    heard = '';
    interim = '';
    recorder.start();
    assistant.speechStarted();
  } else if (event === 'end' && recorder.isRecording) {
    const samples = recorder.stop();
    if (engines.hearing === 'browser') {
      void assistant.speechEnded(null);
      awaitRecogniser();
    } else {
      const wav = encodeWav(resample(samples, mic.sampleRate, STT_RATE), STT_RATE);
      void assistant.speechEnded({ wav, durationMs: (samples.length / mic.sampleRate) * 1000 });
    }
  }
}

function joinWords(a: string, b: string): string {
  a = a.trim();
  b = b.trim();
  if (!a || !b) return a || b;
  return settings.lang === 'zh' ? a + b : `${a} ${b}`;
}

/** Speech has ended; the recogniser may still be finishing the last words. */
function awaitRecogniser(): void {
  clearTimeout(graceTimer);
  if (heard && !interim) return finishRecognition(heard);
  graceTimer = setTimeout(() => {
    const text = joinWords(heard, interim);
    if (!text && recogniserResults === 0 && ++unansweredUtterances >= 2) return recogniserFailed('no answer');
    finishRecognition(text);
  }, RECOGNISER_GRACE_MS);
}

/** Carries on with demo transcripts rather than going deaf. */
function recogniserFailed(reason: string): void {
  recogniser?.stop();
  recogniser = null;
  engines.hearing = 'demo';
  showNotice(`The browser's speech recognition isn't working here (${reason}), so the demo makes up what you said.`);
  if (assistant.state !== 'transcribing') return;
  const partial = joinWords(heard, interim);
  if (partial) return finishRecognition(partial);
  const signal = AbortSignal.timeout(5000);
  void engines.stt.transcribe({ wav: encodeWav(new Float32Array(0), STT_RATE), durationMs: 0 }, signal).then(finishRecognition, () => finishRecognition(''));
}

function finishRecognition(text: string): void {
  clearTimeout(graceTimer);
  heard = '';
  interim = '';
  if (assistant.state === 'transcribing') void assistant.transcript(text);
  schedule();
}

function startRecogniser(): void {
  recogniser = new BrowserRecogniser({
    lang,
    onFinal: (text) => {
      recogniserResults++;
      // Finals while the assistant talks are mostly its own voice: ignore them.
      if (assistant.state === 'hearing') {
        heard = joinWords(heard, text);
        interim = '';
      } else if (assistant.state === 'transcribing') {
        finishRecognition(joinWords(heard, text));
      }
      schedule();
    },
    onInterim: (text) => {
      recogniserResults++;
      if (assistant.state === 'hearing' || assistant.state === 'transcribing') interim = text;
      schedule();
    },
    // Chromium builds without Google's speech service and offline browsers fail here.
    onError: (code) => recogniserFailed(code),
  });
  recogniserResults = 0;
  unansweredUtterances = 0;
  recogniser.start();
}

let starting = false;
async function startListening(): Promise<void> {
  if (starting) return; // A second tap while the permission prompt is open.
  starting = true;
  try {
    mic ??= new Microphone(onFrame);
    await mic.start();
  } catch (e) {
    mic = null;
    showNotice(microphoneError(e));
    return;
  } finally {
    starting = false;
  }
  vad = new Vad({ sampleRate: mic.sampleRate, startDb: START_DB });
  recorder = new UtteranceRecorder(mic.sampleRate);
  if (engines.hearing === 'browser') startRecogniser();
  showNotice(null);
  assistant.start();
}

function stopListening(): void {
  assistant?.stop();
  recogniser?.stop();
  recogniser = null;
  clearTimeout(graceTimer);
  heard = '';
  interim = '';
  void mic?.stop();
  vad = null;
  recorder = null;
  setLevel(0);
}

function microphoneError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (!navigator.mediaDevices) return 'The microphone needs a secure page (HTTPS or localhost). You can still type.';
  if (name === 'NotAllowedError') return 'Microphone access was blocked. Allow it in the address bar, or type your question.';
  if (name === 'NotFoundError') return 'No microphone was found. You can still type your question.';
  return `The microphone could not start (${e instanceof Error ? e.message : String(e)}). You can still type.`;
}

/** Browsers only play sound after a tap; every tap makes sure the voice can be heard. */
let synthesisUnlocked = false;
function unlockAudio(): void {
  if (engines.serverVoice) void outputContext().resume();
  if (!synthesisUnlocked && browserCanSpeak()) {
    synthesisUnlocked = true;
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }
}

// --- Rendering -------------------------------------------------------------

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
}

let level = 0;
let levelScheduled = false;
function setLevel(value: number): void {
  level = Math.max(0, Math.min(1, value));
  if (levelScheduled) return;
  levelScheduled = true;
  requestAnimationFrame(() => {
    levelScheduled = false;
    orb.style.setProperty('--level', level.toFixed(3));
  });
}

function showNotice(text: string | null): void {
  notice.hidden = !text;
  notice.textContent = text ?? '';
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ms(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function metricChips(m: TurnMetrics): string {
  const chips: [string, number | undefined, string][] = [
    ['voice to voice', m.voiceToVoiceMs, 'From the end of your speech to the first sound of the answer'],
    ['speech to text', m.sttMs, 'From the end of your speech to the transcript'],
    ['first token', m.firstTokenMs, 'From the question to the first word from the model'],
    ['first audio', m.firstAudioMs, 'From the question to the first sound'],
  ];
  return chips
    .filter(([, v]) => v !== undefined)
    .map(([name, v, title], i) => `<span class="chip${i === 0 ? ' key' : ''}" title="${title}">${name} <b>${ms(v!)}</b></span>`)
    .join('');
}

function turnHtml(t: Turn, live: boolean): string {
  const text = (s: string) => escapeHtml(s).replace(/\n+/g, '<br>');
  // After a barge-in, fade what was written but never heard.
  const cut = t.interrupted && t.heardChars !== undefined && t.heardChars < t.reply.length ? t.heardChars : t.reply.length;
  const unheard = cut < t.reply.length ? `<span class="unheard" title="Not heard: you interrupted">${text(t.reply.slice(cut))}</span>` : '';
  const reply = t.reply
    ? text(t.reply.slice(0, cut)) + unheard
    : live
      ? ''
      : t.error
        ? ''
        : '<span class="muted">(no answer)</span>';
  const cursor = live ? '<span class="cursor" aria-hidden="true"></span>' : '';
  const tags = [
    t.interrupted ? '<span class="tag">interrupted</span>' : '',
    !live ? metricChips(t.metrics) : '',
    !live && t.metrics.model ? `<span class="model">${escapeHtml(t.metrics.model)}</span>` : '',
  ].join('');
  return `
    <article class="turn" data-id="${t.id}">
      <div class="you"><div class="bubble">${escapeHtml(t.user)}</div></div>
      <div class="answer">${reply}${cursor}</div>
      ${t.error ? `<p class="error">${escapeHtml(t.error)}</p>` : ''}
      ${tags ? `<div class="meta">${tags}</div>` : ''}
    </article>`;
}

function render(): void {
  const s = assistant.state;
  const listening = assistant.listening;
  orb.dataset.state = s;
  orb.classList.toggle('on', listening);
  orb.setAttribute('aria-pressed', String(listening));

  const busy = s === 'thinking' || s === 'speaking';
  orb.setAttribute('aria-label', listening ? 'Stop listening' : busy ? 'Stop the answer' : 'Start talking');
  stateLabel.textContent = {
    idle: 'Tap to talk',
    listening: 'Listening…',
    hearing: 'Hearing you…',
    transcribing: 'Got it…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  }[s];
  hint.textContent = !listening
    ? busy
      ? 'Tap to stop'
      : 'Hands-free: it listens again after every answer.'
    : s === 'speaking'
      ? settings.headphones
        ? 'Talk to interrupt'
        : 'Speak up to interrupt, or tap to stop'
      : 'Tap to stop listening';

  const live = s === 'hearing' || s === 'transcribing' ? joinWords(heard, interim) : '';
  caption.textContent = live ? `“${live}”` : '';

  // Errors outside a turn (microphone, transcription, voice) go to the notice;
  // a failed answer shows its error in the conversation.
  const error = assistant.lastError;
  if (error !== shownError) {
    shownError = error;
    if (error && assistant.turns.at(-1)?.error !== error) showNotice(error);
  }

  if (assistant.turns.length === 0) {
    const examples = MOCK_TRANSCRIPTS[settings.lang];
    list.innerHTML = `
      <div class="empty">
        <p>Tap the microphone and ask something. Try interrupting while it answers.</p>
        <div class="suggestions">${examples.map((e) => `<button type="button" class="suggestion">${escapeHtml(e)}</button>`).join('')}</div>
      </div>`;
    return;
  }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const turns = assistant.turns.slice(-30);
  list.innerHTML = turns.map((t) => turnHtml(t, !t.done)).join('');
  if (nearBottom || !turns.at(-1)!.done) list.scrollTop = list.scrollHeight;
}

// --- Events ----------------------------------------------------------------

orb.addEventListener('click', () => {
  if (!ready) return;
  unlockAudio();
  if (assistant.listening) stopListening();
  else if (assistant.state === 'thinking' || assistant.state === 'speaking') assistant.interrupt();
  else void startListening();
  schedule();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !ready) return;
  unlockAudio();
  input.value = '';
  showNotice(null);
  void assistant.sendText(text);
});

list.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.suggestion');
  if (!button || !ready) return;
  unlockAudio();
  void assistant.sendText(button.textContent ?? '');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dialog.open && ready) assistant.interrupt();
});

$<HTMLButtonElement>('#new-chat').addEventListener('click', () => void configure());

// --- Settings --------------------------------------------------------------

const settingsForm = $<HTMLFormElement>('#settings-form');
const field = <T extends HTMLElement>(name: string) => settingsForm.elements.namedItem(name) as unknown as T;

$<HTMLButtonElement>('#open-settings').addEventListener('click', () => {
  if (!ready) return;
  for (const radio of settingsForm.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.checked = radio.value === settings.mode;
  }
  field<HTMLInputElement>('serverUrl').value = settings.serverUrl;
  field<HTMLSelectElement>('lang').value = settings.lang;
  field<HTMLInputElement>('speak').checked = settings.speak;
  field<HTMLInputElement>('headphones').checked = settings.headphones;
  $<HTMLElement>('#engine-label').textContent =
    `${engines.model}; hearing with ${hearingLabel(engines.hearing)}; speaking with ${engines.voice}.`;
  dialog.showModal();
});

field<HTMLInputElement>('serverUrl').addEventListener('input', () => {
  for (const radio of settingsForm.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.checked = radio.value === 'server';
  }
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  const mode = (settingsForm.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'auto') as Mode;
  settings = {
    mode,
    serverUrl: field<HTMLInputElement>('serverUrl').value.trim(),
    lang: field<HTMLSelectElement>('lang').value === 'zh' ? 'zh' : 'en',
    speak: field<HTMLInputElement>('speak').checked,
    headphones: field<HTMLInputElement>('headphones').checked,
  };
  saveSettings(settings);
  document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
  void configure();
});

document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
void configure();
