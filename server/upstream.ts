import { readSse } from '../shared/sse.ts';
import type { ChatRequest, StreamEvent } from '../shared/types.ts';

export class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Endpoint {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

function auth(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function check(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  let message = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? message;
  } catch {
    // Not JSON.
  }
  throw new UpstreamError(res.status, `${what} returned ${res.status}${message ? `: ${message}` : ''}`);
}

interface CompletionChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string };
}

/** `POST /chat/completions` with `stream: true`, as [StreamEvent]s. */
export async function* chatStream(request: ChatRequest, o: Endpoint & { model: string }): AsyncGenerator<StreamEvent> {
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...auth(o.apiKey) },
    body: JSON.stringify({
      model: o.model,
      messages: request.messages,
      stream: true,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }),
    signal: o.signal ?? null,
  });
  await check(res, 'the model API');
  if (!res.body) throw new UpstreamError(502, 'the model API sent no body');
  yield { type: 'start', provider: new URL(o.baseUrl).host, model: o.model };
  let finishReason = 'stop';
  for await (const message of readSse(res.body)) {
    if (message.data === '[DONE]') break;
    let chunk: CompletionChunk;
    try {
      chunk = JSON.parse(message.data) as CompletionChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new UpstreamError(502, chunk.error.message ?? 'model error');
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  yield { type: 'done', finishReason };
}

/** `POST /audio/transcriptions` (Whisper and compatibles). */
export async function transcribe(
  wav: Uint8Array,
  o: Endpoint & { model: string; language?: string },
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', o.model);
  form.append('response_format', 'json');
  if (o.language) form.append('language', o.language);
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: auth(o.apiKey),
    body: form,
    signal: o.signal ?? null,
  });
  await check(res, 'speech to text');
  const j = (await res.json()) as { text?: unknown };
  if (typeof j.text !== 'string') throw new UpstreamError(502, 'speech to text sent no text');
  return j.text;
}

/** `POST /audio/speech`; returns the audio response to stream on. */
export async function speak(text: string, o: Endpoint & { model: string; voice: string }): Promise<Response> {
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(o.apiKey) },
    body: JSON.stringify({ model: o.model, voice: o.voice, input: text, response_format: 'mp3' }),
    signal: o.signal ?? null,
  });
  await check(res, 'text to speech');
  if (!res.body) throw new UpstreamError(502, 'text to speech sent no audio');
  return res;
}
