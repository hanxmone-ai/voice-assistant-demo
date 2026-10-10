/**
 * Microphone frames for the VAD: ~20 ms of mono samples at the device rate,
 * via an AudioWorklet (ScriptProcessor on old browsers). Echo cancellation
 * stays on so the assistant's own voice is mostly removed, which is what
 * makes interrupting it possible without headphones.
 */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buf = new Float32Array(options.processorOptions.frame);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Microphone {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioNode | null = null;
  private readonly onFrame: (frame: Float32Array) => void;

  constructor(onFrame: (frame: Float32Array) => void) {
    this.onFrame = onFrame;
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get running(): boolean {
    return this.context !== null;
  }

  /** Asks for the microphone (must run from a tap or click). */
  async start(): Promise<void> {
    if (this.context) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const context = new AudioContext();
    this.context = context;
    const source = context.createMediaStreamSource(this.stream);
    const frame = Math.round(context.sampleRate * 0.02);
    if (context.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, 'tap', { processorOptions: { frame } });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data);
      source.connect(node);
      this.node = node;
    } else {
      const node = context.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (e) => this.onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(context.destination);
      this.node = node;
    }
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    await context?.close();
  }
}
