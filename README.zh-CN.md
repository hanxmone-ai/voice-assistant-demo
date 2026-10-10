# 语音助手演示

在浏览器里运行的免按键语音助手：它能听出你什么时候说完，**模型还在生成时就开始说话**，**你一插话它就停下来**。不依赖框架，也不需要"按住说话"。一个小型 Node 服务器转发任何兼容 OpenAI 接口的语音识别、对话和语音合成服务，API Key 只放在服务器上。

**[在线演示](https://hanxmone-ai.github.io/voice-assistant-demo/)**：用模拟模型，加上浏览器自带的语音识别和语音，不需要 API Key。

[English](README.md)

## 做了什么

- **不用按键的轮流对话**：浏览器每 20 毫秒分析一帧麦克风音频（AudioWorklet）。判断方法是能量阈值加上随房间自动调整的背景噪声，所以风扇声不会被当成说话。录音会往前多留 300 毫秒，第一个字不会被截掉。
- **回答没写完就开始说**：模型的流式输出边到边切成句子，支持中英文，不会在小数点或缩写处切开。第一句立刻送去合成语音，播第一句的同时合成第二句，等待时间大约是一句话，而不是整段回答。
- **插话打断**：它说话时你一开口，模型调用和声音同时停止。对话历史里只保留你真正听到的部分，模型知道自己在哪里被打断；没听到的部分在界面上以删除线显示。用外放而不是耳机时，回声消除保持开启，打断需要大声一点，避免它被自己的声音打断。
- **延迟一目了然**：每轮对话都显示"语音到语音"（你说完到听到回答的第一个声音）、语音识别耗时、首字延迟、首个声音延迟。
- **适配任何兼容 OpenAI 的服务**：`/audio/transcriptions`、流式 `/chat/completions`、`/audio/speech`，三者可以分别配置不同的地址和密钥。
- **逐级降级**：没有服务器时用模拟模型和浏览器自带的 `SpeechRecognition`、`speechSynthesis`；浏览器不支持语音识别时，演示会自动生成问题；麦克风被禁用时，可以打字。
- **服务器有防护**：只收合法的 WAV 并限制大小和时长，每个接口单独按 IP 限流，另有 CORS 白名单和上游超时；关掉页面会同时取消对模型的调用。

## 运行

```bash
npm install
npm run build
STATIC_DIR=build/web npm start          # http://localhost:8788，模拟模型 + 浏览器语音
```

接真实模型（填了模型名才会启用语音识别和语音合成），例如对话用 DeepSeek，语音用 OpenAI：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... CHAT_MODEL=deepseek-chat \
STT_BASE_URL=https://api.openai.com/v1 STT_API_KEY=sk-... STT_MODEL=whisper-1 \
TTS_BASE_URL=https://api.openai.com/v1 TTS_API_KEY=sk-... TTS_MODEL=tts-1 \
STATIC_DIR=build/web npm start
```

也可以用 Docker，配置项见 [.env.example](.env.example)。麦克风要求 HTTPS（或 `localhost`）。

## 浏览器

- **Chrome、Edge**：功能全部可用。没有服务器端语音识别时，浏览器会把音频发到它自己的识别服务。
- **Safari**：可以识别语音，语音效果取决于系统。
- **Firefox**：不支持语音识别，需要服务器配置 `STT_MODEL`，否则演示会自动生成问题。
- 戴耳机打断效果最好；用外放时说话大声一点。

## 测试

`npm test` 共 50 个测试，覆盖：用合成音频测试语音检测、句子切分、语音队列、用假模型跑完整对话流程（打断、历史、耗时、错误）、SSE 解析，以及用假的模型接口测试服务器各个接口。CI 在 Node 22 和 24 上运行，对构建产物和 Docker 镜像做冒烟测试，再把前端发布到 GitHub Pages。

## 许可证

[MIT](LICENSE) © 2026 Yihan Qiu
