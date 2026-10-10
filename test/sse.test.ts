import { describe, expect, it } from 'vitest';

import { encodeSse, readSse, SseParser } from '../shared/sse.ts';

describe('SseParser', () => {
  it('parses events, data and ids', () => {
    const p = new SseParser();
    expect(p.push('event: delta\nid: 7\ndata: {"a":1}\n\n')).toEqual([{ event: 'delta', id: '7', data: '{"a":1}' }]);
  });

  it('defaults the event name to message and joins multi-line data', () => {
    const p = new SseParser();
    expect(p.push('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('copes with chunks split anywhere, including inside CRLF', () => {
    const text = 'event: delta\r\ndata: hello\r\n\r\nevent: done\r\ndata: x\r\n\r\n';
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser();
      const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
      expect(got.map((m) => `${m.event}:${m.data}`), `cut at ${cut}`).toEqual(['delta:hello', 'done:x']);
    }
  });

  it('accepts lone CR line endings', () => {
    expect(new SseParser().push('data: a\r\r')).toEqual([{ event: 'message', data: 'a' }]);
  });

  it('ignores comments, unknown fields and empty messages', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\nfoo: bar\n\nevent: x\n\n')).toEqual([]);
  });

  it('keeps a value without the optional space, and the retry field', () => {
    expect(new SseParser().push('data:tight\nretry: 3000\n\n')).toEqual([{ event: 'message', data: 'tight', retry: 3000 }]);
  });

  it('drops a message cut off before its blank line', () => {
    const p = new SseParser();
    expect(p.push('data: partial\n')).toEqual([]);
    expect(p.end()).toEqual([]);
  });
});

describe('encodeSse', () => {
  it('round-trips through the parser, including newlines in data', () => {
    const data = JSON.stringify({ text: 'line 1\nline 2' }) + '\nraw second line';
    const wire = encodeSse({ event: 'delta', data, id: '3' });
    expect(wire.endsWith('\n\n')).toBe(true);
    expect(new SseParser().push(wire)).toEqual([{ event: 'delta', data, id: '3' }]);
  });
});

describe('readSse', () => {
  it('reads from a byte stream with multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode(encodeSse({ data: '你好 👋' }) + encodeSse({ event: 'done', data: 'ok' }));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const got = [];
    for await (const m of readSse(body)) got.push(m);
    expect(got).toEqual([
      { event: 'message', data: '你好 👋' },
      { event: 'done', data: 'ok' },
    ]);
  });

  it('cancels the body when the reader stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(encodeSse({ data: 'first' })));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const m of readSse(body)) {
      expect(m.data).toBe('first');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
