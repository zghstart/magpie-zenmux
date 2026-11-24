# magpie-zenmux

Unified multimodal **ZenMux** provider plugin for [Magpie](https://github.com/yetone/magpie) and OpenCode.

Unlike text-only ZenMux plugins or standalone media adapters, `magpie-zenmux` integrates **all 257 ZenMux models across 8 modalities** under a single `zenmux` provider namespace while keeping a clean, curated default selection:

- **Curated Default Selection + Full 257-Model On-Demand Catalog**:
  - **24 Flagship Chat Models Checked by Default**: Only the latest flagship models across Anthropic (`claude-fable-5.2`, `claude-opus-5.5`, `claude-sonnet-5.5`), OpenAI (`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`), Google (`gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-4-carbon`), DeepSeek (`deepseek-v4.1-flash`, `deepseek-v4-pro`), Qwen (`qwen4-max`), Moonshot (`kimi-k3.1-pro`), Z.AI (`glm-5.3-prime`), MiniMax (`minimax-m3.1-flash`), xAI (`grok-4.7`), Tencent (`hy4-flash`), Xiaomi (`mimo-v2.6-pro`), and Mistral (`mistral-large-4`) are selected by default. All remaining ~148 older chat models stay unchecked in the editor for on-demand selection.
  - **Optional `curatedOnly` toggle**: Hide legacy generations from the picker completely if desired.
- **4 Text Protocols with Zero-Translation Multi-Protocol Pass-Through (`also`)**:
  - Automatic per-model routing across OpenAI Chat Completions (`/api/v1/chat/completions`), OpenAI Responses (`/api/v1/responses`), Anthropic Messages (`/api/anthropic/v1/messages`), and Vertex Gemini (`/api/vertex-ai/v1/publishers/...:streamGenerateContent`).
  - Declares secondary protocols via Magpie's `also` capability so Claude Code (`/v1/messages`) and Codex (`/v1/responses`) talk natively without lossy protocol translation.
- **All 36 Image Models in `magpie-image` (`generate_image` & Image Editing)**:
  - **12 OpenAI `/api/v1/images` models**: `openai/gpt-image-2.6-sunburst`, `gpt-image-2.6-flare`, `gpt-image-2`, `minimax/minimax-h3-image*`, `inclusionai/llada-image*`, `meta/muse-image-1.0`, `x-ai/grok-imagine-image-2.0`.
  - **19 Vertex Imagen `:predict` models**: `bytedance/doubao-seedream-5.5`, `qwen/qwen-image-3.0-pro`, `bfl/flux-3-image`, `klingai/kling-image-4.0`, `tencent/hy-image-v3.5-preview`, `z-ai/glm-image`, `sapiens-ai/agnes-image-2.1-flash`, etc.
  - **5 Vertex Gemini `:generateContent` image models**: `google/gemini-nano-banana-2.1`, `google/gemini-3-pro-image`, `google/gemini-3.1-flash-image`, `google/gemini-3.1-flash-lite-image`, `google/gemini-2.5-flash-image`.
  - Supports both text-to-image (`/v1/images/generations`) and reference-image editing (`/v1/images/edits` in both JSON and `multipart/form-data`).
- **All 24 Video Models in `magpie-image` (`generate_video` & `generation_result`)**:
  - Built-in support for all 3 ZenMux video protocols (superseding `magpie-zenmux-video`):
    - **16 Native `/api/v1/videos` models**: `klingai/kling-4.0`, `bytedance/doubao-seedance-2.5*`, `minimax/minimax-h3*`, `alibaba/wan3.0-video*`, `pixverse/v6`, `bfl/flux-3-video`.
    - **6 Vertex Veo LRO models**: `google/veo-3.1-*`, `alibaba/happyhorse-1.0`, `skyreels/skyreels-v4`, `sapiens-ai/agnes-video-v2.0`.
    - **2 Gemini Omni Interactions models**: `google/gemini-omni-1.2-flash`, `google/gemini-omni-1.1-flash-preview`.
- **Speech (TTS), Transcription (ASR), Embeddings, Rerank & System One Decisions**:
  - **6 TTS models (`/v1/audio/speech`)**: Automatically unwraps ZenMux's base64 JSON audio envelope into playable binary audio (`audio/mpeg` / `audio/wav`), wraps raw 24kHz PCM into WAV, and normalizes OpenAI voice names (`alloy` → `Kore` for Gemini TTS, native defaults for Qwen/Grok TTS).
  - **6 ASR models (`/v1/audio/transcriptions`)**: Converts Magpie's incoming `multipart/form-data` audio uploads into ZenMux's JSON `input_audio` payload (and `/chat/completions` `input_audio` for `qwen/qwen3-asr-flash`).
  - **4 Embedding models (`/v1/embeddings`)** & **2 Rerank models (`/v1/rerank`)**: Normalizes Cohere/Jina `{ query, documents, top_n }` into ZenMux's `{ input: { query, documents }, parameters: { top_n } }`.
  - **7 Decision models (`/v1/systemone`)**: Native System One (`typesafe/jev-*`, `microsoft/microsoft-decision-1.1`) plus automatic System One ⇄ OpenAI Decisions translation for `cloudflare/clef*` and `openai/gpt-6-luna`.
- **Dual Billing Mode (Pay-As-You-Go & Builder Plan) + OAuth PKCE**:
  - Detects `sk-payg-…` vs `sk-subs-…` vs OAuth accounts automatically.
  - Displays real-time PAYG USD balance (`/api/v1/management/payg/balance`) or Builder Plan 5h/7d Flow windows (`/api/v1/management/subscription/detail`) when an optional `sk-mgmt-…` Management API Key is provided.

## Installation

Add `github:zghstart/magpie-zenmux#main` (or `magpie-zenmux@latest` if published to npm) to `~/.config/magpie/plugins.json`:

```json
{
  "plugins": [
    {
      "spec": "github:zghstart/magpie-zenmux#main"
    }
  ]
}
```

## Testing

```bash
npm test
```

## License

MIT
