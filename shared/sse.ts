/**
 * Server-sent events, both directions: encoding for the server and an
 * incremental parser that follows the WHATWG spec (any line ending, chunks
 * split anywhere, multi-line data, comments, ids).
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** One SSE message. Multi-line data becomes several `data:` lines. */
export function encodeSse(message: { event?: string; data: string; id?: string }): string {
  let out = '';
  if (message.event) out += `event: ${message.event}\n`;
  if (message.id !== undefined) out += `id: ${message.id}\n`;
  for (const line of message.data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return out + '\n';
}

/** A comment line; proxies and browsers ignore it, so it keeps idle connections open. */
export const SSE_HEARTBEAT = ': keep-alive\n\n';

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;
  /** The last chunk ended in CR, so a LF at the start of the next one belongs to it. */
  private pendingCr = false;

  /** Feeds decoded text; returns the messages it completed. */
  push(chunk: string): SseMessage[] {
    if (this.pendingCr && chunk.startsWith('\n')) chunk = chunk.slice(1);
    this.pendingCr = chunk.endsWith('\r');
    this.buffer += chunk;
    const out: SseMessage[] = [];
    const lines = this.buffer.split(/\r\n|\r|\n/);
    // The last piece has no line ending yet.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line, out);
    return out;
  }

  /** Ends the stream. A message without its closing blank line is dropped, as the spec says. */
  end(): SseMessage[] {
    this.buffer = '';
    this.data = [];
    this.event = '';
    return [];
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.data.length > 0) {
        const message: SseMessage = { event: this.event || 'message', data: this.data.join('\n') };
        if (this.id !== undefined) message.id = this.id;
        if (this.retry !== undefined) message.retry = this.retry;
        out.push(message);
      }
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
  }
}

/** Reads SSE messages from a fetch body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    finished = true;
    yield* parser.push(decoder.decode());
    parser.end();
  } finally {
    // Stopped early (the caller broke out of the loop): close the connection.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
