export interface Config {
  port: number;
  /** OpenAI-compatible base URL. Empty: mock model, no server STT/TTS. */
  llmBaseUrl: string;
  llmApiKey: string;
  model: string;
  /** Speech to text; empty disables it (the browser recognises speech instead). */
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
  /** Text to speech; empty disables it (the browser speaks instead). */
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  systemPrompt: string;
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  maxAudioBytes: number;
  maxSpeakChars: number;
  maxInputChars: number;
  maxMessages: number;
  staticDir: string;
  upstreamTimeoutMs: number;
  trustProxy: boolean;
}

export const VOICE_PROMPT =
  'You are a voice assistant. Answers are spoken aloud, so reply in one to three short sentences, ' +
  'with no Markdown, lists, code or URLs. Use the language of the question.';

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const int = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
    return n;
  };
  const base = (v: string | undefined) => (v ?? '').replace(/\/+$/, '');
  const llmBaseUrl = base(env.LLM_BASE_URL);
  const llmApiKey = env.LLM_API_KEY ?? '';
  return {
    port: int('PORT', 8788),
    llmBaseUrl,
    llmApiKey,
    model: env.CHAT_MODEL || 'gpt-4o-mini',
    // Speech is on when a model is named; it uses the chat provider unless told otherwise.
    sttBaseUrl: env.STT_MODEL ? base(env.STT_BASE_URL) || llmBaseUrl : '',
    sttApiKey: env.STT_API_KEY ?? llmApiKey,
    sttModel: env.STT_MODEL ?? '',
    ttsBaseUrl: env.TTS_MODEL ? base(env.TTS_BASE_URL) || llmBaseUrl : '',
    ttsApiKey: env.TTS_API_KEY ?? llmApiKey,
    ttsModel: env.TTS_MODEL ?? '',
    ttsVoice: env.TTS_VOICE || 'alloy',
    systemPrompt: env.SYSTEM_PROMPT ?? VOICE_PROMPT,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 30),
    maxAudioBytes: int('MAX_AUDIO_BYTES', 2 * 1024 * 1024),
    maxSpeakChars: int('MAX_SPEAK_CHARS', 600),
    maxInputChars: int('MAX_INPUT_CHARS', 8000),
    maxMessages: int('MAX_MESSAGES', 30),
    staticDir: env.STATIC_DIR ?? '',
    upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 30000),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
