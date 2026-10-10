import { afterEach, describe, expect, it } from 'vitest';

import { encodeWav } from '../shared/wav.ts';
import { createApp, type AppDeps } from '../server/app.ts';
import { loadConfig, VOICE_PROMPT } from '../server/config.ts';
import { events, openAiChunks, serve, text } from './helpers.ts';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

const fastMock: AppDeps['mock'] = { sleep: async () => undefined, random: () => 0.5 };

async function start(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const app = await serve(createApp(loadConfig({ RATE_LIMIT_PER_MINUTE: '100', ...env }), { mock: fastMock, log: (l) => logs.push(l) }));
  stops.push(app.close);
  return { ...app, logs };
}

/** A fake OpenAI-compatible API with chat, transcription and speech. */
async function fakeApi() {
  const seen: { path: string; auth?: string; form?: Record<string, string>; json?: Record<string, unknown> }[] = [];
  const api = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const entry: (typeof seen)[number] = { path: req.url ?? '', auth: req.headers.authorization };
    seen.push(entry);
    if (req.url === '/v1/audio/transcriptions') {
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type']! } }).formData();
      entry.form = {};
      for (const [k, v] of form) entry.form[k] = typeof v === 'string' ? v : `file:${v.type}:${v.size}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'turn on the lights' }));
    } else if (req.url === '/v1/audio/speech') {
      entry.json = JSON.parse(body.toString()) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.write(Buffer.from([0xff, 0xfb, 0x90]));
      res.end(Buffer.from([1, 2, 3]));
    } else if (req.url === '/v1/chat/completions') {
      entry.json = JSON.parse(body.toString()) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(openAiChunks(['Lights ', 'are on.']));
    } else {
      res.writeHead(404).end();
    }
  });
  stops.push(api.close);
  return { url: api.url, seen };
}

const wav = () => encodeWav(new Float32Array(16000), 16000); // 1 s of silence

describe('health', () => {
  it('without a model API: mock chat, speech in the browser', async () => {
    const { url } = await start();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true, llm: 'mock', model: 'demo-mock', stt: false, tts: false });
  });

  it('with STT and TTS models', async () => {
    const { url } = await start({ LLM_BASE_URL: 'http://x/v1', CHAT_MODEL: 'm', STT_MODEL: 'whisper-1', TTS_MODEL: 'tts-1' });
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ llm: 'openai-compatible', model: 'm', stt: true, tts: true });
  });
});

describe('chat', () => {
  it('streams the mock model', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    const got = await events(res);
    expect(text(got)).toMatch(/^Hello! I am listening/);
    expect(got.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('relays a real model with the voice system prompt', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: `${api.url}/v1`, LLM_API_KEY: 'sk' });
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'lights?' }] }),
    });
    expect(text(await events(res))).toBe('Lights are on.');
    const sent = api.seen.find((s) => s.path === '/v1/chat/completions')!;
    expect((sent.json!.messages as { content: string }[])[0]!.content).toBe(VOICE_PROMPT);
    expect(sent.auth).toBe('Bearer sk');
  });
});

describe('transcribe', () => {
  it('posts the WAV to /audio/transcriptions as multipart', async () => {
    const api = await fakeApi();
    const { url, logs } = await start({ LLM_BASE_URL: `${api.url}/v1`, LLM_API_KEY: 'sk', STT_MODEL: 'whisper-1' });
    const res = await fetch(`${url}/api/transcribe?lang=zh`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'turn on the lights' });
    const sent = api.seen.find((s) => s.path === '/v1/audio/transcriptions')!;
    expect(sent.form).toEqual({ file: 'file:audio/wav:32044', model: 'whisper-1', response_format: 'json', language: 'zh' });
    expect(sent.auth).toBe('Bearer sk');
    expect(logs.at(-1)).toMatch(/^transcribe 1000 ms of audio/);
  });

  it('a separate STT provider and key', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: 'http://unused/v1', STT_BASE_URL: `${api.url}/v1`, STT_API_KEY: 'stt-key', STT_MODEL: 'w' });
    await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav() });
    expect(api.seen[0]!.auth).toBe('Bearer stt-key');
  });

  it('rejects what it should', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: `${api.url}/v1`, STT_MODEL: 'w', MAX_AUDIO_BYTES: '1000' });
    const post = (body: Uint8Array<ArrayBuffer> | string, type = 'audio/wav') =>
      fetch(`${url}/api/transcribe`, { method: 'POST', headers: { 'content-type': type }, body });
    expect((await post('hello', 'text/plain')).status).toBe(415);
    expect((await post(new Uint8Array(100))).status).toBe(400);
    expect((await post(wav())).status).toBe(413);
    const none = await start();
    expect((await fetch(`${none.url}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav() })).status).toBe(404);
  });

  it('upstream failures become 502 with the reason', async () => {
    const api = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    stops.push(api.close);
    const { url } = await start({ LLM_BASE_URL: api.url, STT_MODEL: 'w' });
    const res = await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav() });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'speech to text returned 401: Invalid API key' });
  });
});

describe('speak', () => {
  it('streams the audio from /audio/speech', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: `${api.url}/v1`, TTS_MODEL: 'tts-1', TTS_VOICE: 'nova' });
    const res = await fetch(`${url}/api/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Lights are on.' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xfb, 0x90, 1, 2, 3]);
    expect(api.seen[0]!.json).toEqual({ model: 'tts-1', voice: 'nova', input: 'Lights are on.', response_format: 'mp3' });
  });

  it('checks the text and that TTS is set up', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: `${api.url}/v1`, TTS_MODEL: 't', MAX_SPEAK_CHARS: '10' });
    const post = (u: string, body: unknown) =>
      fetch(`${u}/api/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, { text: 'x'.repeat(11) })).status).toBe(413);
    const none = await start();
    expect((await post(none.url, { text: 'hi' })).status).toBe(404);
  });

  it('has its own, larger rate limit (one call per sentence)', async () => {
    const api = await fakeApi();
    const { url } = await start({ LLM_BASE_URL: `${api.url}/v1`, TTS_MODEL: 't', RATE_LIMIT_PER_MINUTE: '1' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/api/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hi.' }),
      });
      await r.arrayBuffer();
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });
});
