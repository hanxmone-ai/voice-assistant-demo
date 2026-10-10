import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { mockStream, type MockOptions } from '../shared/mock.ts';
import { encodeSse, SSE_HEARTBEAT } from '../shared/sse.ts';
import { decodeWavInfo } from '../shared/wav.ts';
import type { Capabilities, ChatMessage, ChatRequest, StreamEvent } from '../shared/types.ts';
import type { Config } from './config.ts';
import { RateLimiter } from './rate_limit.ts';
import { chatStream, speak, transcribe, UpstreamError } from './upstream.ts';

export interface AppDeps {
  fetch?: typeof fetch;
  mock?: Omit<MockOptions, 'signal'>;
  heartbeatMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** The request handler for `http.createServer`. */
export function createApp(config: Config, deps: AppDeps = {}) {
  // Speech is asked for once per sentence, so it gets a bigger allowance.
  const limiters = {
    chat: new RateLimiter(config.rateLimitPerMinute, deps.now),
    transcribe: new RateLimiter(config.rateLimitPerMinute, deps.now),
    speak: new RateLimiter(config.rateLimitPerMinute * 4, deps.now),
  };
  const limit = (kind: keyof typeof limiters, req: IncomingMessage, res: ServerResponse) => {
    const wait = limiters[kind].take(clientIp(req, config.trustProxy));
    if (wait > 0) {
      res.setHeader('retry-after', String(wait));
      throw new HttpError(429, `too many requests, try again in ${wait}s`);
    }
  };
  const heartbeatMs = deps.heartbeatMs ?? 15000;
  const log = deps.log ?? ((line: string) => console.log(line));
  const provider = config.llmBaseUrl ? 'openai-compatible' : 'mock';

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!cors(req, res, config)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        const caps: Capabilities = {
          ok: true,
          llm: provider,
          model: config.llmBaseUrl ? config.model : 'demo-mock',
          stt: Boolean(config.sttBaseUrl && config.sttModel),
          tts: Boolean(config.ttsBaseUrl && config.ttsModel),
        };
        return json(res, 200, caps);
      }
      if (url.pathname === '/api/chat') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        limit('chat', req, res);
        const body = validate(await readJson(req, config.maxInputChars * 2 + 4096), config);
        await streamChat(body, req, res);
        return;
      }
      if (url.pathname === '/api/transcribe') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        if (!config.sttBaseUrl || !config.sttModel) throw new HttpError(404, 'speech to text is not set up on this server');
        limit('transcribe', req, res);
        await handleTranscribe(req, res, url.searchParams.get('lang'));
        return;
      }
      if (url.pathname === '/api/speak') {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST');
        if (!config.ttsBaseUrl || !config.ttsModel) throw new HttpError(404, 'text to speech is not set up on this server');
        limit('speak', req, res);
        const body = (await readJson(req, config.maxSpeakChars * 4 + 1024)) as { text?: unknown };
        if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, '"text" is required');
        if (body.text.length > config.maxSpeakChars) throw new HttpError(413, `at most ${config.maxSpeakChars} characters`);
        await handleSpeak(body.text, req, res);
        return;
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (config.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        if (await serveStatic(config.staticDir, url.pathname, req, res)) return;
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${e instanceof Error ? e.stack : String(e)}`);
      json(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
    }
  };

  /** Upstream calls that end when the browser hangs up or the upstream is too slow. */
  function upstreamSignal(res: ServerResponse): { signal: AbortSignal; done: () => void } {
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client closed'));
    };
    res.on('close', onClose);
    const timer = setTimeout(
      () => abort.abort(new UpstreamError(504, 'the speech service took too long')),
      config.upstreamTimeoutMs,
    );
    return {
      signal: abort.signal,
      done: () => {
        clearTimeout(timer);
        res.off('close', onClose);
      },
    };
  }

  async function handleTranscribe(req: IncomingMessage, res: ServerResponse, lang: string | null): Promise<void> {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('audio/wav') && !type.startsWith('audio/x-wav')) throw new HttpError(415, 'send audio/wav');
    const wav = await readBody(req, config.maxAudioBytes);
    let durationMs: number;
    try {
      durationMs = decodeWavInfo(wav).durationMs;
    } catch {
      throw new HttpError(400, 'not a WAV file');
    }
    if (durationMs > 60000) throw new HttpError(413, 'at most 60 seconds of audio');
    const language = lang && /^[a-z]{2}$/.test(lang) ? lang : undefined;
    const { signal, done } = upstreamSignal(res);
    const started = Date.now();
    try {
      const text = await transcribe(wav, {
        baseUrl: config.sttBaseUrl,
        apiKey: config.sttApiKey,
        model: config.sttModel,
        language,
        signal,
        fetch: deps.fetch,
      });
      log(`transcribe ${Math.round(durationMs)} ms of audio in ${Date.now() - started} ms`);
      json(res, 200, { text });
    } catch (e) {
      throw upstreamHttpError(signal.aborted ? signal.reason : e);
    } finally {
      done();
    }
  }

  async function handleSpeak(text: string, _req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { signal, done } = upstreamSignal(res);
    try {
      const upstream = await speak(text, {
        baseUrl: config.ttsBaseUrl,
        apiKey: config.ttsApiKey,
        model: config.ttsModel,
        voice: config.ttsVoice,
        signal,
        fetch: deps.fetch,
      });
      res.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        'cache-control': 'no-store',
      });
      // Stream the audio through as it arrives, so playback can begin early.
      await new Promise<void>((resolveDone, fail) => {
        Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>)
          .on('error', fail)
          .pipe(res)
          .on('finish', resolveDone)
          .on('close', resolveDone);
      });
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      throw upstreamHttpError(signal.aborted ? signal.reason : e);
    } finally {
      done();
    }
  }

  async function streamChat(body: ChatRequest, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController();
    let clientGone = false;
    // The browser pressed Stop or went away: cancel the model call too.
    const onClose = () => {
      if (res.writableEnded) return;
      clientGone = true;
      abort.abort(new Error('client closed'));
    };
    res.on('close', onClose);

    const messages: ChatMessage[] = config.systemPrompt
      ? [{ role: 'system', content: config.systemPrompt }, ...body.messages.filter((m) => m.role !== 'system')]
      : body.messages;
    // Limits the wait for the first event; a long answer may stream for longer.
    const upstreamTimeout = setTimeout(
      () => abort.abort(new UpstreamError(504, 'the model took too long to answer')),
      config.upstreamTimeoutMs,
    );
    const events: AsyncIterable<StreamEvent> = config.llmBaseUrl
      ? chatStream(
          { ...body, messages },
          {
            baseUrl: config.llmBaseUrl,
            apiKey: config.llmApiKey,
            model: config.model,
            signal: abort.signal,
            fetch: deps.fetch,
          },
        )
      : mockStream(messages, { ...deps.mock, signal: abort.signal });

    const iterator = events[Symbol.asyncIterator]();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const started = Date.now();
    let chars = 0;
    try {
      // Wait for the first event before sending headers, so an upstream
      // refusal can still be a normal JSON error with the right status.
      let next = await iterator.next();
      clearTimeout(upstreamTimeout);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      heartbeat = setInterval(() => res.write(SSE_HEARTBEAT), heartbeatMs);
      while (!next.done) {
        if (abort.signal.aborted) break;
        const event = next.value;
        if (event.type === 'delta') chars += event.text.length;
        res.write(encodeSse({ event: event.type, data: JSON.stringify(event) }));
        next = await iterator.next();
      }
    } catch (e) {
      if (clientGone) return; // Nobody left to tell.
      const reason = abort.signal.aborted ? abort.signal.reason : e;
      if (!res.headersSent) {
        if (reason instanceof UpstreamError) {
          // A bad request (e.g. too long for the model) is the caller's; anything else is ours.
          const status = reason.status === 504 ? 504 : [400, 413, 422].includes(reason.status) ? 400 : 502;
          throw new HttpError(status, reason.message);
        }
        throw reason;
      }
      if (!res.writableEnded) {
        const message = reason instanceof Error ? reason.message : 'stream failed';
        const error: StreamEvent = { type: 'error', message };
        res.write(encodeSse({ event: 'error', data: JSON.stringify(error) }));
      }
    } finally {
      clearTimeout(upstreamTimeout);
      clearInterval(heartbeat);
      res.off('close', onClose);
      await iterator.return?.();
      // Before the headers went out, the caller turns the error into a JSON response.
      if (res.headersSent && !res.writableEnded) res.end();
      log(`chat ${provider} ${chars} chars in ${Date.now() - started} ms${abort.signal.aborted ? ' (aborted)' : ''}`);
    }
  }
}

/** Upstream problems as the status the browser should see. */
function upstreamHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof UpstreamError) {
    const status = e.status === 504 ? 504 : [400, 413, 415, 422].includes(e.status) ? 400 : 502;
    return new HttpError(status, e.message);
  }
  return new HttpError(502, e instanceof Error ? e.message : String(e));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Sets CORS headers. Returns false (after answering 403) for origins that aren't allowed. */
function cors(req: IncomingMessage, res: ServerResponse, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  const sameOrigin = host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
  if (sameOrigin) return true;
  if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-expose-headers', 'retry-after');
    res.setHeader('access-control-max-age', '600');
    return true;
  }
  json(res, 403, { error: 'origin not allowed' });
  return false;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // The proxy appends the address it saw last; anything before it came from the client.
    const forwarded = req.headers['x-forwarded-for'];
    const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'send application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

const ROLES = new Set(['user', 'assistant', 'system']);

/** Checks the request body and returns it typed. */
export function validate(body: unknown, config: Pick<Config, 'maxInputChars' | 'maxMessages'>): ChatRequest {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object');
  const { messages, temperature } = body as Record<string, unknown>;
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, '"messages" must be a non-empty array');
  if (messages.length > config.maxMessages) throw new HttpError(400, `at most ${config.maxMessages} messages`);
  let total = 0;
  const clean: ChatMessage[] = messages.map((m: unknown, i) => {
    const { role, content } = (m ?? {}) as Record<string, unknown>;
    if (typeof role !== 'string' || !ROLES.has(role)) throw new HttpError(400, `messages[${i}].role is invalid`);
    if (typeof content !== 'string') throw new HttpError(400, `messages[${i}].content must be a string`);
    total += content.length;
    return { role: role as ChatMessage['role'], content };
  });
  if (total > config.maxInputChars) throw new HttpError(413, `conversation is longer than ${config.maxInputChars} characters`);
  if (clean[clean.length - 1]?.role !== 'user') throw new HttpError(400, 'the last message must be from the user');
  const request: ChatRequest = { messages: clean };
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
      throw new HttpError(400, '"temperature" must be between 0 and 2');
    }
    request.temperature = temperature;
  }
  return request;
}

async function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const base = resolve(root);
  let relative: string;
  try {
    relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = join(base, relative);
  if (file !== base && !file.startsWith(base + sep)) return false;
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return false;
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    // Vite puts a content hash in asset names, so they can be cached for good.
    'cache-control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((done, fail) => {
    createReadStream(file).on('error', fail).on('end', done).pipe(res);
  });
  return true;
}
