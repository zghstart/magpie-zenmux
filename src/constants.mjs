export const PROVIDER_ID = "zenmux";
export const PROVIDER_NAME = "ZenMux";

export const DEFAULT_ORIGIN = "https://zenmux.ai";
export const API_BASE_URL = "https://zenmux.ai/api/v1";
export const ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic/v1";
export const VERTEX_BASE_URL = "https://zenmux.ai/api/vertex-ai/v1";
export const VERTEX_BETA_BASE_URL = "https://zenmux.ai/api/vertex-ai/v1beta";
export const MANAGEMENT_BASE_URL = "https://zenmux.ai/api/v1/management";
export const PUBLIC_API_BASE_URL = "https://zenmux.ai/api";

export const NPM_PACKAGES = Object.freeze({
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
});

export const SUBSCRIPTION_KEY_RE = /^sk-(subs-|ss-v1-)/;
export const PAYG_KEY_RE = /^sk-(payg-|ai-v1-)/;
export const MANAGEMENT_KEY_RE = /^sk-mgmt-/;
export const LEGACY_KEY_RE = /^sk-(ss-v1-|ai-v1-|mg-v1-)/;
export const ANY_KEY_RE = /^sk-[A-Za-z0-9._-]{8,}$/;
export const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9.:_-]*$/i;

export const EFFORTS = Object.freeze({
  low: Object.freeze({}),
  medium: Object.freeze({}),
  high: Object.freeze({}),
  xhigh: Object.freeze({}),
  max: Object.freeze({}),
});

export const THINKING_BUDGETS = Object.freeze({
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 5120,
  high: 10240,
  xhigh: 24576,
  max: 32768,
  ultra: 32768,
});

// Top 24 curated latest-generation flagship chat models across vendors.
// Magpie's Provider.Exposed() selects the first 24 available chat models by
// default when the user has not saved custom picks, leaving older models
// unchecked in the editor for on-demand selection.
export const CURATED_CHAT_MODELS = Object.freeze([
  "anthropic/claude-fable-5.2",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6.2-astra",
  "openai/gpt-6.2-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-6-luna",
  "google/gemini-4-neon",
  "google/gemini-4-argon",
  "google/gemini-4-hydrogen",
  "google/gemini-4-carbon",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-pro",
  "qwen/qwen4-max",
  "qwen/qwen3.8-omni-flash",
  "moonshotai/kimi-k3.1-pro",
  "moonshotai/kimi-k3.1-pro-highspeed",
  "z-ai/glm-5.3-prime",
  "minimax/minimax-m3.1-flash",
  "x-ai/grok-4.7",
  "tencent/hy4-flash",
  "xiaomi/mimo-v2.6-pro",
  "mistralai/mistral-large-4",
]);

// Curated latest-generation image models (19 flagships). Older generations
// remain in the catalog and can be ticked on demand.
export const CURATED_IMAGE_MODELS = Object.freeze([
  "openai/gpt-image-2.6-sunburst",
  "openai/gpt-image-2.6-flare",
  "openai/gpt-image-2",
  "bytedance/doubao-seedream-5.5",
  "google/gemini-nano-banana-2.1",
  "google/gemini-3-pro-image",
  "google/gemini-3.1-flash-image",
  "qwen/qwen-image-3.0-pro",
  "qwen/qwen-image-3.0",
  "bfl/flux-3-image",
  "klingai/kling-image-4.0",
  "minimax/minimax-h3-image",
  "minimax/minimax-h3-image-highspeed",
  "tencent/hy-image-v3.5-preview",
  "x-ai/grok-imagine-image-2.0",
  "meta/muse-image-1.0",
  "inclusionai/llada-image-turbo",
  "z-ai/glm-image",
  "sapiens-ai/agnes-image-2.1-flash",
]);

// Older image generations left unticked by default in hiddenDrawers.
export const LEGACY_IMAGE_MODELS = Object.freeze([
  "openai/gpt-image-2.5-sunburst",
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-1.5",
  "bytedance/doubao-seedream-5.0-pro",
  "bytedance/doubao-seedream-5.0-flash",
  "bytedance/doubao-seedream-5.0-lite",
  "google/gemini-3.1-flash-lite-image",
  "google/gemini-2.5-flash-image",
  "qwen/qwen-image-2.0-pro",
  "qwen/qwen-image-2.0",
  "bfl/flux-2-max",
  "bfl/flux-2-pro",
  "bfl/flux-2-flex",
  "klingai/kling-v3",
  "klingai/kling-v2",
  "tencent/hy-image-v3.0",
  "inclusionai/llada-image",
]);

// Curated latest-generation video models (14 flagships).
export const CURATED_VIDEO_MODELS = Object.freeze([
  "bytedance/doubao-seedance-2.5",
  "bytedance/doubao-seedance-2.5-flash",
  "klingai/kling-4.0",
  "google/veo-3.1-generate-001",
  "google/veo-3.1-fast-generate-001",
  "google/gemini-omni-1.2-flash",
  "minimax/minimax-h3-max",
  "minimax/minimax-h3-highspeed",
  "alibaba/wan3.0-video-prime",
  "alibaba/happyhorse-1.0",
  "pixverse/v6",
  "bfl/flux-3-video",
  "skyreels/skyreels-v4",
  "sapiens-ai/agnes-video-v2.0",
]);

// Older video generations left unticked by default in hiddenVideomakers.
export const LEGACY_VIDEO_MODELS = Object.freeze([
  "bytedance/doubao-seedance-2.0",
  "klingai/kling-3.0",
  "klingai/kling-3.0-turbo",
  "klingai/kling-3.0-omni",
  "google/veo-3.1-lite-generate-001",
  "google/gemini-omni-1.1-flash-preview",
  "minimax/minimax-h3",
  "minimax/minimax-h3-lite",
  "alibaba/wan3.0-video",
  "pixverse/c1",
]);

export const DEFAULT_FALLBACK_MODELS = Object.freeze({
  "anthropic/claude-fable-5.2": {
    name: "Anthropic: Claude Fable 5.2",
    reasoning: true,
    tool_call: true,
    limit: { context: 200000, output: 64000 },
  },
  "openai/gpt-6.2-astra": {
    name: "OpenAI: GPT-6.2 Astra",
    reasoning: true,
    tool_call: true,
    limit: { context: 1050000, output: 128000 },
  },
  "google/gemini-4-neon": {
    name: "Google: Gemini 4 Neon",
    reasoning: true,
    tool_call: true,
    limit: { context: 1048576, output: 65535 },
  },
  "deepseek/deepseek-v4.1-flash": {
    name: "DeepSeek: DeepSeek V4.1 Flash",
    reasoning: true,
    tool_call: true,
    limit: { context: 1000000, output: 384000 },
  },
});

export function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}

export function trimNum(v) {
  const n = num(v);
  if (n === undefined) return String(v ?? "");
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

export function cap(s) {
  const t = String(s ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export function problem(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
