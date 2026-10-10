import { createServer } from 'node:http';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const server = createServer(createApp(config));

server.listen(config.port, () => {
  const mode = [config.llmBaseUrl ? `chat: ${config.model}` : 'chat: mock model', config.sttModel ? `stt: ${config.sttModel}` : 'stt: browser', config.ttsModel ? `tts: ${config.ttsModel}` : 'tts: browser'].join(', ');
  console.log(`voice-assistant-demo on http://localhost:${config.port} — ${mode}`);
});

function shutdown(): void {
  // Stop accepting connections; streams in progress get 10 s to finish.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
