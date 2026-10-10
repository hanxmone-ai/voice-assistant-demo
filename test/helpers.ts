import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readSse } from '../shared/sse.ts';
import type { StreamEvent } from '../shared/types.ts';

/** Starts [handler] on a free port; returns its base URL and a stopper. */
export async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export async function events(res: Response): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const m of readSse(res.body!)) out.push(JSON.parse(m.data) as StreamEvent);
  return out;
}

export function text(events: StreamEvent[]): string {
  return events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
}

/** An OpenAI-style streaming response from [chunks]. */
export function openAiChunks(chunks: string[], { usage = true } = {}): string {
  const lines = chunks.map(
    (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`,
  );
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);

  lines.push('data: [DONE]\n\n');
  return lines.join('');
}
