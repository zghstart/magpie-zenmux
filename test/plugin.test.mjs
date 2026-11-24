import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ZenMuxPlugin, { _internal } from "../index.mjs";
const {
  CURATED_CHAT_MODELS,
  CURATED_IMAGE_MODELS,
  CURATED_VIDEO_MODELS,
  normalizeCatalogEntries,
  toMagpieModel,
} = _internal;
import { pcmToWav } from "../src/protocols/audio.mjs";

function loadFixture(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

test("Live 257-model ZenMux catalog normalizes all 8 modalities and places 24 curated chat flagships first", () => {
  const avail = loadFixture("/tmp/zenmux-available-list.json");
  const v1 = loadFixture("/tmp/zenmux-live-models.json");
  const vert = loadFixture("/tmp/zenmux-vertex-models.json");
  if (!avail || !v1 || !vert) return;

  const records = normalizeCatalogEntries({
    availableList: avail.data,
    v1Models: v1.data,
    vertexModels: vert.models,
  });

  assert.equal(records.length, 257);

  const byKind = {};
  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }
  assert.equal(byKind.image, 36, "All 36 image models must be classified as image");
  assert.equal(byKind.video, 24, "All 24 video models must be classified as video");
  assert.equal(byKind.speech, 6, "All 6 TTS models must be classified as speech");
  assert.equal(byKind.transcription, 6, "All 6 ASR models must be classified as transcription");
  assert.equal(byKind.embedding, 4, "All 4 embedding models must be classified as embedding");
  assert.equal(byKind.rerank, 2, "All 2 rerank models must be classified as rerank");
  assert.equal(byKind.decision, 6, "All 6 pure decision models must be classified as decision");
  assert.equal(byKind.chat, 173, "All 173 chat models must be classified as chat");

  // Verify the first 24 models are the exact 24 CURATED_CHAT_MODELS so Magpie's
  // default Exposed() (avail[:24]) picks only the 24 curated flagships.
  const first24Ids = records.slice(0, 24).map((r) => r.id);
  assert.deepEqual(first24Ids, [...CURATED_CHAT_MODELS]);

  // Verify image models sort with CURATED_IMAGE_MODELS first
  const imageRecords = records.filter((r) => r.kind === "image");
  assert.deepEqual(
    imageRecords.slice(0, CURATED_IMAGE_MODELS.length).map((r) => r.id),
    [...CURATED_IMAGE_MODELS],
  );

  // Verify video models sort with CURATED_VIDEO_MODELS first
  const videoRecords = records.filter((r) => r.kind === "video");
  assert.deepEqual(
    videoRecords.slice(0, CURATED_VIDEO_MODELS.length).map((r) => r.id),
    [...CURATED_VIDEO_MODELS],
  );

  // Verify Magpie model capability contracts
  for (const r of imageRecords) {
    const m = toMagpieModel(r);
    assert.equal(m.api.npm, "@ai-sdk/openai-compatible", `${r.id} must use @ai-sdk/openai-compatible for DrawersOf`);
    assert.equal(m.capabilities.output.image, true);
    assert.equal(m.capabilities.output.text, false, `${r.id} must have text:false so imagesOnly is true`);
  }

  for (const r of videoRecords) {
    const m = toMagpieModel(r);
    assert.equal(m.capabilities.output.video, true);
    assert.equal(m.capabilities.output.text, false);
  }

  for (const r of records.filter((x) => ["transcription", "embedding", "rerank"].includes(x.kind))) {
    const m = toMagpieModel(r);
    assert.equal(m.capabilities.output.text, false, `${r.id} must not appear in chat pickers`);
    assert.equal(m.capabilities.output.image, false);
    assert.equal(m.capabilities.output.video, false);
  }
});

test("End-to-end plugin routing across text (4 protocols), images (3 protocols), videos (3 protocols), TTS, ASR, rerank, and System One", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-zenmux-test-"));
  const calls = [];

  const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");
  const mp3Base64 = Buffer.from("ID3-fake-mp3").toString("base64");
  const pcmBase64 = Buffer.alloc(480, 1).toString("base64");

  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const bodyText = typeof init.body === "string" ? init.body : "";
    let bodyJson = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }
    calls.push({ url, method, headers: new Headers(init.headers), bodyText, bodyJson });

    if (url.endsWith("/frontend/model/available/list")) {
      return Response.json({
        success: true,
        data: [
          {
            slug: "anthropic/claude-fable-5.2",
            name: "Anthropic: Claude Fable 5.2",
            input_modalities: "text,image",
            output_modalities: "text",
            suitable_api: "chat.completions,messages,responses",
            supports_reasoning: 1,
            publish_time: "2026-11-10",
            pricing_discount: "0.8",
          },
          {
            slug: "openai/gpt-image-2.6-sunburst",
            name: "OpenAI: GPT-Image-2.6-Sunburst",
            input_modalities: "text,image",
            output_modalities: "image",
            suitable_api: "images",
            publish_time: "2026-11-05",
          },
          {
            slug: "bytedance/doubao-seedream-5.5",
            name: "ByteDance: Doubao-Seedream-5.5",
            input_modalities: "text,image",
            output_modalities: "image",
            suitable_api: "imagen",
            supported_parameters: "negativePrompt,referenceImages,aspectRatio,addWatermark,imageSize",
            publish_time: "2026-11-13",
          },
          {
            slug: "google/gemini-nano-banana-2.1",
            name: "Google: Gemini Nano Banana 2.1",
            input_modalities: "text,image",
            output_modalities: "image,text",
            suitable_api: "gemini",
            publish_time: "2026-11-14",
          },
          {
            slug: "klingai/kling-4.0",
            name: "KlingAI: Kling 4.0",
            input_modalities: "text,image",
            output_modalities: "video",
            suitable_api: "videos",
            publish_time: "2026-11-20",
          },
          {
            slug: "google/veo-3.1-generate-001",
            name: "Google: Veo 3.1",
            input_modalities: "text,image",
            output_modalities: "video",
            suitable_api: "veo",
            publish_time: "2026-10-10",
          },
          {
            slug: "qwen/qwen-audio-3.1-tts-next",
            name: "Qwen Audio 3.1 TTS Next",
            input_modalities: "text",
            output_modalities: "speech",
            suitable_api: "audio.speech",
            publish_time: "2026-11-04",
          },
          {
            slug: "x-ai/grok-voice-tts-1.0",
            name: "Grok Voice TTS 1.0",
            input_modalities: "text",
            output_modalities: "speech",
            suitable_api: "audio.speech",
            publish_time: "2026-11-01",
          },
          {
            slug: "qwen/qwen-audio-3.1-asr-flash",
            name: "Qwen Audio 3.1 ASR Flash",
            input_modalities: "audio",
            output_modalities: "transcription",
            suitable_api: "audio.transcriptions",
            publish_time: "2026-11-04",
          },
          {
            slug: "qwen/qwen3-rerank",
            name: "Qwen3 Rerank",
            input_modalities: "text",
            output_modalities: "rerank",
            suitable_api: "rerank",
            publish_time: "2026-10-01",
          },
          {
            slug: "cloudflare/clef-flash",
            name: "Cloudflare Clef Flash",
            input_modalities: "text,image",
            output_modalities: "decisions",
            suitable_api: "decisions",
            publish_time: "2026-10-12",
          },
        ],
      });
    }

    if (url.endsWith("/api/v1/models")) {
      return Response.json({ data: [] });
    }
    if (url.endsWith("/api/vertex-ai/v1beta/models")) {
      return Response.json({ models: [] });
    }
    if (url.endsWith("/management/payg/balance")) {
      return Response.json({
        success: true,
        data: { currency: "usd", total_credits: 181.905, top_up_credits: 181.905, bonus_credits: 0 },
      });
    }
    if (url.endsWith("/api/anthropic/v1/messages")) {
      return Response.json({ id: "msg_1", content: [{ type: "text", text: "ok" }] });
    }
    if (url.endsWith("/api/v1/images/generations") || url.endsWith("/api/v1/images/edits")) {
      return Response.json({ created: 1, data: [{ b64_json: pngBase64 }] });
    }
    if (url.endsWith("/publishers/bytedance/models/doubao-seedream-5.5:predict")) {
      return Response.json({ predictions: [{ bytesBase64Encoded: pngBase64, mimeType: "image/png" }] });
    }
    if (url.endsWith("/publishers/google/models/gemini-nano-banana-2.1:generateContent")) {
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "Generated nano banana" },
                { inlineData: { mimeType: "image/png", data: pngBase64 } },
              ],
            },
          },
        ],
      });
    }
    if (url.endsWith("/api/v1/videos") && method === "POST") {
      return Response.json({ id: "job_kling_1", status: "queued" });
    }
    if (url.endsWith("/api/v1/videos/job_kling_1") && method === "GET") {
      return Response.json({ id: "job_kling_1", status: "succeeded", content: { video_url: "https://zenmux.ai/cdn/video1.mp4" } });
    }
    if (url === "https://zenmux.ai/cdn/video1.mp4") {
      return new Response("fake-mp4-stream", { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (url.endsWith("/publishers/google/models/veo-3.1-generate-001:predictLongRunning")) {
      return Response.json({ name: "publishers/google/models/veo-3.1-generate-001/operations/op_123", done: false });
    }
    if (url.endsWith("/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation")) {
      return Response.json({
        name: "publishers/google/models/veo-3.1-generate-001/operations/op_123",
        done: true,
        response: { videos: [{ bytesBase64Encoded: Buffer.from("veo-mp4").toString("base64"), mimeType: "video/mp4" }] },
      });
    }
    if (url.endsWith("/api/v1/audio/speech")) {
      if (bodyJson?.model === "x-ai/grok-voice-tts-1.0") {
        return Response.json({ audio: pcmBase64, mime_type: "audio/pcm", model: bodyJson.model });
      }
      return Response.json({ audio: mp3Base64, mime_type: "audio/mpeg", model: bodyJson?.model });
    }
    if (url.endsWith("/api/v1/audio/transcriptions")) {
      return Response.json({ text: "你好，喜鹊。", model: bodyJson?.model });
    }
    if (url.endsWith("/api/v1/rerank")) {
      return Response.json({
        object: "list",
        results: [{ index: 0, relevance_score: 0.99, document: { text: bodyJson?.input?.documents?.[0] } }],
      });
    }
    if (url.endsWith("/api/v1/decisions")) {
      return Response.json({
        model: bodyJson?.model,
        answers: [{ name: "coding", type: "predicate", probability: 0.92 }],
        usage: { input_tokens: 42, output_tokens: 0 },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const plugin = await ZenMuxPlugin({ directory: dir }, { fetchImpl: mockFetch });
    const auth = {
      type: "api",
      key: "sk-payg-test123456",
      metadata: { managementKey: "sk-mgmt-test123456" },
    };

    // 1. Models & Usage
    const models = await plugin.provider.models({}, { auth });
    assert.ok(models["anthropic/claude-fable-5.2"]);
    assert.deepEqual(models["anthropic/claude-fable-5.2"].also, ["@ai-sdk/openai-compatible", "@ai-sdk/openai"]);
    assert.equal(models["anthropic/claude-fable-5.2"].rate, 0.8);
    assert.equal(models["anthropic/claude-fable-5.2"].rateWas, 1);

    const usage = await plugin.auth.usage(async () => auth);
    assert.equal(usage.plan, "Pay As You Go");
    assert.equal(usage.balance, "$181.91");

    const loader = await plugin.auth.loader(async () => auth);

    // 2. Text cross-protocol pass-through (/v1/messages on /api/v1 base + x-magpie-effort)
    const msgRes = await loader.fetch("https://zenmux.ai/api/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-effort": "max" },
      body: JSON.stringify({ model: "anthropic/claude-fable-5.2", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(msgRes.status, 200);
    const msgCall = calls.find((c) => c.url.endsWith("/api/anthropic/v1/messages"));
    assert.ok(msgCall, "Must rewrite /api/v1/messages to /api/anthropic/v1/messages");
    assert.equal(msgCall.bodyJson.thinking.budget_tokens, 32768);
    assert.equal(msgCall.bodyJson.max_tokens, 36864);

    // 3. Image generation across all 3 protocols (images, imagen :predict, gemini :generateContent)
    for (const [model, size] of [
      ["openai/gpt-image-2.6-sunburst", "1536x1024"],
      ["bytedance/doubao-seedream-5.5", "1536x1024"],
      ["google/gemini-nano-banana-2.1", "1536x1024"],
    ]) {
      const imgRes = await loader.fetch("https://zenmux.ai/api/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "Chongqing tea house", size, watermark: false }),
      });
      assert.equal(imgRes.status, 200);
      const imgJson = await imgRes.json();
      assert.equal(imgJson.data[0].b64_json, pngBase64);
    }
    const seedreamCall = calls.find((c) => c.url.endsWith("/publishers/bytedance/models/doubao-seedream-5.5:predict"));
    assert.equal(seedreamCall.bodyJson.parameters.aspectRatio, "3:2");
    assert.equal(seedreamCall.bodyJson.parameters.addWatermark, false);

    // 4. Multipart /v1/images/edits support
    const editForm = new FormData();
    editForm.set("model", "bytedance/doubao-seedream-5.5");
    editForm.set("prompt", "Add lanterns");
    editForm.set("image", new Blob([Buffer.from("raw-img")], { type: "image/png" }), "in.png");
    const editRes = await loader.fetch("https://zenmux.ai/api/v1/images/edits", {
      method: "POST",
      body: editForm,
    });
    assert.equal(editRes.status, 200);
    const editCall = calls[calls.length - 1];
    assert.equal(editCall.bodyJson.instances[0].referenceImages.length, 1);

    // 5. Video generation (Native + Vertex Veo LRO)
    for (const model of ["klingai/kling-4.0", "google/veo-3.1-generate-001"]) {
      const startRes = await loader.fetch("https://zenmux.ai/api/v1/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "A flying magpie", size: "1280x720", seconds: 5 }),
      });
      assert.equal(startRes.status, 200);
      const started = await startRes.json();
      assert.equal(started.status, "queued");

      const pollRes = await loader.fetch(`https://zenmux.ai/api/v1/videos/${started.id}`, { method: "GET" });
      const polled = await pollRes.json();
      assert.equal(polled.status, "completed");

      const contentRes = await loader.fetch(`https://zenmux.ai/api/v1/videos/${started.id}/content`, { method: "GET" });
      assert.equal(contentRes.status, 200);
      assert.equal(contentRes.headers.get("content-type"), "video/mp4");
    }

    // 6. Speech (TTS) JSON unwrapping & PCM -> WAV header wrapping
    const ttsMp3 = await loader.fetch("https://zenmux.ai/api/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen-audio-3.1-tts-next", input: "你好", voice: "alloy" }),
    });
    assert.equal(ttsMp3.status, 200);
    assert.equal(ttsMp3.headers.get("content-type"), "audio/mpeg");
    assert.equal(Buffer.from(await ttsMp3.arrayBuffer()).toString(), "ID3-fake-mp3");

    const ttsWav = await loader.fetch("https://zenmux.ai/api/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x-ai/grok-voice-tts-1.0", input: "Hello", voice: "alloy" }),
    });
    assert.equal(ttsWav.status, 200);
    assert.equal(ttsWav.headers.get("content-type"), "audio/wav");
    const wavBytes = Buffer.from(await ttsWav.arrayBuffer());
    assert.equal(wavBytes.subarray(0, 4).toString(), "RIFF");

    // 7. Audio Transcription (multipart/form-data -> JSON input_audio)
    const asrForm = new FormData();
    asrForm.set("model", "qwen/qwen-audio-3.1-asr-flash");
    asrForm.set("file", new Blob([pcmToWav(Buffer.alloc(100))], { type: "audio/wav" }), "test.wav");
    const asrRes = await loader.fetch("https://zenmux.ai/api/v1/audio/transcriptions", {
      method: "POST",
      body: asrForm,
    });
    assert.equal(asrRes.status, 200);
    const asrJson = await asrRes.json();
    assert.equal(asrJson.text, "你好，喜鹊。");

    // 8. Rerank normalization (Cohere/Jina shape -> DashScope input/parameters)
    const rerankRes = await loader.fetch("https://zenmux.ai/api/v1/rerank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3-rerank", query: "bird", documents: ["magpie", "sql"], top_n: 1 }),
    });
    assert.equal(rerankRes.status, 200);
    const rerankJson = await rerankRes.json();
    assert.equal(rerankJson.results[0].document.text, "magpie");

    // 9. System One -> Decisions translation for Cloudflare Clef
    const sysRes = await loader.fetch("https://zenmux.ai/api/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cloudflare/clef-flash",
        state: "write python code",
        questions: { coding: { type: "noul", instructions: "Is this coding?" } },
      }),
    });
    assert.equal(sysRes.status, 200);
    const sysJson = await sysRes.json();
    assert.equal(sysJson.answers.coding.noul, 0.92);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
