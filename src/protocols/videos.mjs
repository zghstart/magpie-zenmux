import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { API_BASE_URL, MODEL_SLUG_RE, VERTEX_BASE_URL, problem } from "../constants.mjs";
import { resolveVideoProtocol } from "../catalog.mjs";

const RATIOS = [
  [1, 1],
  [16, 9],
  [9, 16],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [21, 9],
  [9, 21],
];

export function videoSize(size) {
  if (size == null || size === "") return {};
  if (typeof size !== "string") throw problem(400, "size must be an aspect ratio or WIDTHxHEIGHT");
  if (/^(360|480|720|768|1080|2160)p$/i.test(size)) return { resolution: size.toLowerCase() };
  if (/^[1-9]\d?:[1-9]\d?$/.test(size)) return { ratio: size };
  const match = /^(\d{1,5})[x×](\d{1,5})$/i.exec(size);
  if (!match) throw problem(400, "size must be an aspect ratio or WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) throw problem(400, "Video dimensions must be positive");
  const ratio = RATIOS.find(([w, h]) => Math.abs(width / height / (w / h) - 1) < 0.02);
  if (!ratio) throw problem(400, `Unsupported video aspect ratio for ${size}`);
  const short = Math.min(width, height);
  const resolution = [360, 480, 720, 768, 1080, 2160].find((tier) => tier >= short);
  if (!resolution) throw problem(400, `Unsupported video resolution for ${size}`);
  return { ratio: ratio.join(":"), resolution: `${resolution}p` };
}

export function inlineImage(value) {
  if (typeof value !== "string") throw problem(400, "Expected a base64 image data URL");
  const header = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(value);
  if (!header) throw problem(400, "This video model requires an inline image data URL");
  const data = value.slice(header[0].length);
  if (!data || data.length % 4 === 1 || (data.includes("=") && data.length % 4 !== 0) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw problem(400, "Invalid base64 image");
  }
  return { mimeType: header[1].toLowerCase(), data };
}

// ---- 1. Native /api/v1/videos adapter (16 models) ---------------------------

function nativeJobId(value, status) {
  if (typeof value !== "string" || value.length > 512 || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(value)) {
    throw problem(status, "Invalid ZenMux video job ID");
  }
  return value;
}

function nativeImageItem(role, url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) inlineImage(url);
  return { type: "image_url", role, image_url: { url } };
}

function putOption(options, field, value) {
  if (value === undefined) return;
  if (Object.hasOwn(options, field) && options[field] !== value) {
    throw problem(400, `Conflicting values for video ${field}`);
  }
  options[field] = value;
}

export function buildNativeVideoRequest(body) {
  const { model, prompt, seconds, size, input_reference, last_frame, reference_images, content = [], ...options } = body;
  if (!Array.isArray(content)) throw problem(400, "Native video content must be an array");
  const items = [];
  if (prompt != null) {
    if (typeof prompt !== "string") throw problem(400, "Video prompt must be a string");
    if (prompt.length) items.push({ type: "text", text: prompt });
  }
  if (input_reference != null) items.push(nativeImageItem("first_frame", input_reference));
  if (last_frame != null) items.push(nativeImageItem("last_frame", last_frame));
  if (reference_images != null) {
    if (!Array.isArray(reference_images)) throw problem(400, "reference_images must be an array of images");
    for (const image of reference_images) items.push(nativeImageItem("reference_image", image));
  }
  for (const item of content) items.push(item);
  if (!items.length) throw problem(400, "Native video generation requires a prompt or media content");
  const dimensions = size === "adaptive" ? { ratio: "adaptive" } : videoSize(size);
  putOption(options, "ratio", dimensions.ratio);
  putOption(options, "resolution", dimensions.resolution);
  if (typeof model === "string" && model.startsWith("minimax/")) {
    const hasImage = items.some((it) => it?.type === "image_url");
    if (!options.ratio || (!hasImage && options.ratio === "adaptive")) {
      options.ratio = "16:9";
    }
    if (!options.resolution) {
      options.resolution = "768P";
    } else if (typeof options.resolution === "string") {
      const r = options.resolution.trim().toUpperCase();
      options.resolution = r === "720P" ? "768P" : r;
    }
  }
  if (seconds != null) {
    const duration = typeof seconds === "string" ? Number(seconds) : seconds;
    if (!Number.isSafeInteger(duration) || duration <= 0) throw problem(400, "seconds must be a positive integer");
    putOption(options, "duration", duration);
  }
  return { model, content: items, ...options };
}

function parseNativeVideoResult(job, includeMedia) {
  switch (job?.status) {
    case "queued":
      return { status: "queued" };
    case "running":
      return { status: "in_progress" };
    case "failed": {
      const { code, message } = job.error ?? {};
      const error = { message: typeof message === "string" && message ? message : "ZenMux video generation failed" };
      if (code != null) error.code = String(code);
      return { status: "failed", error };
    }
    case "succeeded": {
      const url = job.content?.video_url;
      if (typeof url !== "string" || !url) {
        return { status: "failed", error: { code: "missing_media", message: "ZenMux completed without content.video_url" } };
      }
      return includeMedia ? { status: "completed", media: { url } } : { status: "completed" };
    }
    default:
      throw problem(502, `Unknown ZenMux video status: ${job?.status ?? "missing"}`);
  }
}

// ---- 2. Vertex Veo LRO adapter (6 models) -----------------------------------

const VERTEX_PARAM_NAMES = new Map([
  ["aspect_ratio", "aspectRatio"],
  ["duration_seconds", "durationSeconds"],
  ["generate_audio", "generateAudio"],
  ["negative_prompt", "negativePrompt"],
  ["enhance_prompt", "enhancePrompt"],
  ["person_generation", "personGeneration"],
  ["sample_count", "sampleCount"],
  ["numberOfVideos", "sampleCount"],
  ["number_of_videos", "sampleCount"],
  ["seed", "seed"],
  ["fps", "fps"],
  ["resolution", "resolution"],
  ["resize_mode", "resizeMode"],
  ["compression_quality", "compressionQuality"],
]);
for (const field of [...VERTEX_PARAM_NAMES.values()]) VERTEX_PARAM_NAMES.set(field, field);

function vertexModelPath(model) {
  if (typeof model !== "string" || !MODEL_SLUG_RE.test(model)) {
    throw problem(400, "Invalid Vertex publisher/model identifier");
  }
  const [publisher, name] = model.split("/");
  return `publishers/${publisher}/models/${name}`;
}

function vertexOperationName(name, resource, status) {
  const match =
    typeof name === "string" &&
    name.length <= 2048 &&
    /^(?:projects\/[\w.-]+\/locations\/[\w-]+\/)?(publishers\/[\w.-]+\/models\/[\w.-]+)\/operations\/[\w-][\w.-]*$/.exec(name);
  if (!match || match[1] !== resource) throw problem(status, "Invalid Vertex operation name for this model");
  return name;
}

function vertexImage(dataUrl) {
  const { mimeType, data } = inlineImage(dataUrl);
  return { mimeType, bytesBase64Encoded: data };
}

export function buildVertexVideoRequest(body) {
  const { model, prompt, size, seconds, input_reference, last_frame, reference_images, parameters = {}, ...options } = body;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw problem(400, "Vertex parameters must be an object");
  }
  const config = { ...parameters };
  const instance = {};
  putOption(instance, "prompt", prompt);
  if (input_reference != null) instance.image = vertexImage(input_reference);
  if (last_frame != null) instance.lastFrame = vertexImage(last_frame);
  if (reference_images !== undefined) {
    if (!Array.isArray(reference_images)) throw problem(400, "reference_images must be an array of image data URLs");
    if (reference_images.length) {
      instance.referenceImages = reference_images.map((src) => ({ image: vertexImage(src), referenceType: "asset" }));
    }
  }
  if (size != null) {
    const { ratio, resolution } = videoSize(size);
    if (!ratio && !resolution) throw problem(400, "Unsupported Vertex video size");
    putOption(config, "aspectRatio", ratio);
    putOption(config, "resolution", resolution);
  }
  if (seconds != null) {
    const duration = typeof seconds === "string" ? Number(seconds) : seconds;
    if (!Number.isSafeInteger(duration) || duration <= 0) throw problem(400, "seconds must be a positive integer");
    putOption(config, "durationSeconds", duration);
  }
  for (const [key, value] of Object.entries(options)) {
    if (VERTEX_PARAM_NAMES.has(key)) putOption(config, VERTEX_PARAM_NAMES.get(key), value);
    else if (["image", "lastFrame", "video", "referenceImages", "mask"].includes(key)) putOption(instance, key, value);
    else throw problem(400, `Unsupported Vertex video option: ${key}. Pass vendor generation parameters in parameters.`);
  }
  if (instance.lastFrame && !instance.image) throw problem(400, "A Vertex last frame requires a first frame");
  if (config.sampleCount !== undefined && config.sampleCount !== 1) {
    throw problem(400, "Magpie returns one video per job. Set sampleCount to 1.");
  }
  return { instances: [instance], parameters: config };
}

function parseVertexVideoResult(op, pendingStatus, includeMedia) {
  if (!op || typeof op !== "object" || Array.isArray(op)) throw problem(502, "Invalid Vertex operation response");
  if (op.error) {
    const code = op.error.status ?? op.error.code;
    return {
      status: "failed",
      error: code == null ? { message: op.error.message || "Vertex video generation failed" } : { message: op.error.message || "Vertex video generation failed", code: String(code) },
    };
  }
  if (op.done === undefined || op.done === false) return { status: pendingStatus };
  if (op.done !== true) throw problem(502, "Invalid Vertex operation completion flag");
  const response = op.response;
  const video = response?.videos?.[0];
  if (!video && (response?.raiMediaFilteredCount > 0 || response?.raiMediaFilteredReasons?.length)) {
    const reasons = Array.isArray(response.raiMediaFilteredReasons) ? response.raiMediaFilteredReasons.join(", ") : "";
    return { status: "failed", error: { message: reasons || "Vertex filtered the generated video", code: "content_filtered" } };
  }
  let media;
  if (typeof video?.bytesBase64Encoded === "string" && video.bytesBase64Encoded.length) {
    media = { base64: video.bytesBase64Encoded, mimeType: video.mimeType || "video/mp4" };
  } else if (typeof video?.gcsUri === "string" && /^https:\/\//i.test(video.gcsUri)) {
    media = { url: video.gcsUri };
  } else {
    return { status: "failed", error: { message: "Vertex completed without a downloadable video", code: "missing_media" } };
  }
  return includeMedia ? { status: "completed", media } : { status: "completed" };
}

// ---- 3. Gemini Omni Interactions adapter (2 models) -------------------------

const OMNI_PREVIEW = "google/gemini-omni-1.1-flash-preview";
const OMNI_CURRENT = "google/gemini-omni-1.2-flash";

export function buildInteractionsVideoRequest(body) {
  if (body.negative_prompt != null) {
    throw problem(400, "Omni takes negative instructions in the prompt and does not support negative_prompt");
  }
  const { ratio, resolution } = videoSize(body.size);
  const format = { type: "video", delivery: "inline" };
  const aspect = body.aspect_ratio ?? ratio;
  if (aspect != null) {
    if (!["16:9", "9:16"].includes(aspect)) throw problem(400, "Omni supports aspect ratios 16:9 and 9:16");
    format.aspect_ratio = aspect;
  }
  const pixels = body.resolution ?? resolution;
  if (pixels != null) {
    const value = pixels === "2160p" ? "4k" : String(pixels).toLowerCase();
    if (!["360p", "720p", "1080p", "4k"].includes(value)) throw problem(400, "Omni supports 360p, 720p, 1080p and 4k");
    format.resolution = value;
  }
  if (body.seconds != null) {
    const max = body.model === OMNI_PREVIEW || (body.input_reference && body.last_frame) ? 10 : 15;
    const seconds = Number(body.seconds);
    if (!["string", "number"].includes(typeof body.seconds) || !Number.isInteger(seconds) || seconds < 3 || seconds > max) {
      throw problem(400, `Omni duration must be a whole number from 3 to ${max} seconds for this request`);
    }
    format.duration = `${seconds}s`;
  }

  const references = body.reference_images ?? [];
  if (!Array.isArray(references)) throw problem(400, "reference_images must be a list of images");
  if (body.model === OMNI_CURRENT && references.length > 6) {
    throw problem(400, "Omni 1.2 supports up to six reference images");
  }
  const input = [];
  const hasFrames = body.input_reference != null || body.last_frame != null;
  const labelImages = (hasFrames && references.length > 0) || (body.last_frame != null && body.input_reference == null);
  const imgPart = (val) => {
    const { mimeType, data } = inlineImage(val);
    return { type: "image", mime_type: mimeType, data };
  };
  if (body.input_reference != null) {
    if (labelImages) input.push({ type: "text", text: "Use the following image as the first frame." });
    input.push(imgPart(body.input_reference));
  }
  if (body.last_frame != null) {
    if (labelImages) input.push({ type: "text", text: "Use the following image as the last frame." });
    input.push(imgPart(body.last_frame));
  }
  if (references.length) {
    if (labelImages) input.push({ type: "text", text: "Use the following images as subject or scene references." });
    for (const ref of references) input.push(imgPart(ref));
  }
  input.push({ type: "text", text: body.prompt });

  let task;
  if (!labelImages) {
    if (hasFrames) task = "image_to_video";
    else if (references.length) task = "reference_to_video";
    else task = "text_to_video";
  }

  const generationConfig = { ...body.generation_config };
  if (body.seed != null) generationConfig.seed = body.seed;
  if (task) generationConfig.video_config = { task, ...generationConfig.video_config };

  const req = {
    model: body.model,
    input,
    response_format: [format],
    store: false,
    stream: false,
    background: false,
  };
  if (Object.keys(generationConfig).length) req.generation_config = generationConfig;
  for (const key of ["labels", "provider", "model_routing_config"]) {
    if (body[key] != null) req[key] = body[key];
  }
  return req;
}

export function extractInteractionsMedia(response) {
  if (response?.status !== "completed") {
    const detail = response?.error?.message || `Omni returned interaction status ${response?.status ?? "unknown"}`;
    throw problem(502, detail);
  }
  let explanation;
  for (const step of Array.isArray(response.steps) ? response.steps : []) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (part?.type === "text" && typeof part.text === "string") explanation = part.text;
      if (part?.type !== "video") continue;
      if (typeof part.data === "string" && part.data.length > 0) {
        const mimeType = part.mime_type ?? "video/mp4";
        return { base64: part.data, mimeType };
      }
    }
  }
  throw problem(502, `Omni completed without a generated video${explanation ? `: ${explanation}` : ""}`);
}

// ---- Local job store for synchronous Interactions video jobs ----------------

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function createOmniJobs(directory) {
  const root = join(directory, "zenmux-video-jobs");
  let nextSweep = 0;

  async function saveState(folder, record) {
    const tmp = join(folder, "state.tmp");
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, join(folder, "state.json"));
  }

  async function sweep() {
    if (nextSweep > Date.now()) return;
    nextSweep = Date.now() + DAY_MS / 24;
    const cutoff = Date.now() - DAY_MS;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const dir = join(root, entry.name);
      const info = await stat(dir).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(dir, { force: true, recursive: true });
    }
  }

  return {
    async start(model, run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await sweep();
      const id = randomUUID();
      const folder = join(root, id);
      await mkdir(folder, { mode: 0o700 });
      const record = { model, status: "in_progress", pid: process.pid, started: Date.now() };
      await saveState(folder, record);

      void (async () => {
        const tmp = join(folder, "video.part");
        try {
          const media = await run();
          const buf = Buffer.from(media.base64, "base64");
          if (!buf.length) throw new Error("ZenMux returned an empty video");
          await writeFile(tmp, buf, { mode: 0o600, flag: "wx" });
          await rename(tmp, join(folder, "video"));
          await saveState(folder, { ...record, status: "completed", size: buf.length, mime: media.mimeType || "video/mp4" });
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {});
          await saveState(folder, { ...record, status: "failed", error: { message: String(err.message || err).slice(0, 1200) } });
        }
      })().catch(() => {});

      return { id, status: "queued" };
    },
    async read(model, id, content) {
      if (!UUID_RE.test(id)) throw problem(404, "Unknown local video task");
      const folder = join(root, id);
      let job;
      try {
        job = JSON.parse(await readFile(join(folder, "state.json"), "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") throw problem(404, "The local video task has expired or does not exist");
        throw err;
      }
      if (job.model !== model) throw problem(404, "Unknown local video task");
      if (!content) return { status: job.status, ...(job.error && { error: job.error }) };
      if (job.status !== "completed") throw problem(409, job.error?.message || "Video is still being generated");
      return new Response(Readable.toWeb(createReadStream(join(folder, "video"))), {
        headers: { "content-type": job.mime, "content-length": String(job.size) },
      });
    },
  };
}

// ---- Unified Video Router ---------------------------------------------------

export function encodeVideoJobId(protocol, model, remoteId) {
  if (typeof remoteId !== "string" || !remoteId || remoteId.length > 4096) {
    throw problem(502, "ZenMux returned an invalid video task ID");
  }
  return Buffer.from(JSON.stringify([protocol, model, remoteId])).toString("base64url");
}

export function decodeVideoJobId(encoded) {
  if (typeof encoded === "string" && encoded.length <= 6500 && /^[A-Za-z0-9_-]+$/.test(encoded)) {
    let parts;
    try {
      parts = JSON.parse(Buffer.from(encoded, "base64url").toString());
    } catch {
      parts = null;
    }
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      ["native", "vertex", "interactions"].includes(parts[0]) &&
      MODEL_SLUG_RE.test(parts[1]) &&
      typeof parts[2] === "string" &&
      parts[2].length > 0 &&
      parts[2].length <= 4096
    ) {
      return parts;
    }
  }
  throw problem(404, "Unknown ZenMux video task ID");
}

function videoResponse(id, model, state) {
  const out = { object: "video", id, model, status: state.status };
  if (state.progress != null) out.progress = state.progress;
  if (state.error) out.error = state.error;
  return Response.json(out);
}

export function createVideoHandler({
  directory = process.cwd(),
  apiBase = API_BASE_URL,
  vertexBase = VERTEX_BASE_URL,
  findModel,
  fetchImpl = fetch,
} = {}) {
  const jobs = createOmniJobs(directory);
  let recentVertex = null;
  let expiryTimer = null;

  async function callJson(url, { method = "GET", token, body, signal } = {}) {
    const headers = {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      const msg = payload?.error?.message || payload?.message || `ZenMux returned HTTP ${res.status}`;
      throw problem(res.status, msg);
    }
    return payload;
  }

  async function serveMedia(media, signal) {
    if (media?.base64) {
      const bytes = Buffer.from(media.base64, "base64");
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": media.mimeType || "video/mp4",
          "content-length": String(bytes.length),
        },
      });
    }
    if (media?.url) {
      const res = await fetchImpl(media.url, { signal });
      if (!res.ok) throw problem(502, `Could not download generated video (HTTP ${res.status})`);
      const headers = new Headers();
      headers.set("content-type", res.headers.get("content-type") || "video/mp4");
      const len = res.headers.get("content-length");
      if (len) headers.set("content-length", len);
      return new Response(res.body, { status: 200, headers });
    }
    throw problem(502, "ZenMux completed without downloadable video content");
  }

  return async function handleVideoRequest(req, routeMatch, { token } = {}) {
    const taskId = routeMatch[1];
    const isContent = Boolean(routeMatch[2]);

    if (req.method === "POST" && !taskId) {
      let body;
      try {
        body = await req.json();
      } catch {
        throw problem(400, "A JSON video request is required");
      }
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!MODEL_SLUG_RE.test(model)) throw problem(400, "A valid ZenMux publisher/model ID is required");

      const record = findModel ? await findModel(model, { token, signal: req.signal }) : null;
      const protocol = record?.video_protocol ?? resolveVideoProtocol(record ?? { id: model, supported_apis: [] });

      let state;
      if (protocol === "interactions") {
        const payload = buildInteractionsVideoRequest(body);
        state = await jobs.start(model, async () => {
          const response = await callJson(`${apiBase}/interactions`, {
            method: "POST",
            token,
            body: payload,
            signal: AbortSignal.timeout(15 * 60 * 1000),
          });
          return extractInteractionsMedia(response);
        });
      } else if (protocol === "vertex") {
        const resource = vertexModelPath(model);
        const payload = buildVertexVideoRequest(body);
        const op = await callJson(`${vertexBase}/${resource}:predictLongRunning`, {
          method: "POST",
          token,
          body: payload,
          signal: req.signal,
        });
        state = {
          id: vertexOperationName(op?.name, resource, 502),
          ...parseVertexVideoResult(op, "queued", false),
        };
      } else {
        const payload = buildNativeVideoRequest(body);
        const job = await callJson(`${apiBase}/videos`, {
          method: "POST",
          token,
          body: payload,
          signal: req.signal,
        });
        state = {
          id: nativeJobId(job?.id, 502),
          ...parseNativeVideoResult(job, false),
        };
      }
      return videoResponse(encodeVideoJobId(protocol, model, state.id), model, state);
    }

    if (req.method !== "GET" || !taskId) {
      throw problem(405, "Unsupported video operation");
    }

    const [protocol, model, remoteId] = decodeVideoJobId(taskId);
    if (protocol === "interactions") {
      const state = await jobs.read(model, remoteId, isContent);
      return isContent ? state : videoResponse(taskId, model, state);
    }

    let state;
    if (protocol === "vertex" && recentVertex?.id === taskId) {
      state = recentVertex.state;
    } else if (protocol === "vertex") {
      const resource = vertexModelPath(model);
      const opName = vertexOperationName(remoteId, resource, 400);
      const op = await callJson(`${vertexBase}/${resource}:fetchPredictOperation`, {
        method: "POST",
        token,
        body: { operationName: opName },
        signal: req.signal,
      });
      state = parseVertexVideoResult(op, "in_progress", true);
      if (!isContent && state.status === "completed") {
        clearTimeout(expiryTimer);
        recentVertex = { id: taskId, state };
        expiryTimer = setTimeout(() => {
          recentVertex = null;
        }, 60_000);
        expiryTimer.unref?.();
      }
    } else {
      const job = await callJson(`${apiBase}/videos/${nativeJobId(remoteId, 400)}`, {
        method: "GET",
        token,
        signal: req.signal,
      });
      state = parseNativeVideoResult(job, isContent);
    }

    if (!isContent) return videoResponse(taskId, model, state);
    if (state.status !== "completed") throw problem(409, state.error?.message || "Video is still being generated");
    return serveMedia(state.media, req.signal);
  };
}
