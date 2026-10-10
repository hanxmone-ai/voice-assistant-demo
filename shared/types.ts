export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
}

/** What the chat endpoint streams, one per SSE message (`event:` is the type). */
export type StreamEvent =
  | { type: 'start'; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string };

export const STREAM_EVENT_TYPES = ['start', 'delta', 'done', 'error'] as const;

/** What the server can do, from `GET /api/health`. */
export interface Capabilities {
  ok: true;
  /** `mock` without a model API. */
  llm: string;
  model: string;
  /** Speech to text on the server. */
  stt: boolean;
  /** Text to speech on the server. */
  tts: boolean;
}
