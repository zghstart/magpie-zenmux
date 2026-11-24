import { API_BASE_URL, VERTEX_BASE_URL, isObj, num, problem } from "../constants.mjs";
import { resolveImageProtocol } from "../catalog.mjs";

const STANDARD_RATIOS = [
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

export function parseImageDimensions(size, resolution) {
  let aspectRatio;
  let imageTier;
  let rawSize;

  if (typeof resolution === "string" && /^(1K|2K|4K)$/i.test(resolution.trim())) {
    imageTier = resolution.trim().toUpperCase();
  }

  if (typeof size === "string" && size.trim()) {
    const s = size.trim();
    if (/^(1K|2K|4K)$/i.test(s)) {
      imageTier = s.toUpperCase();
    } else if (/^[1-9]\d?:[1-9]\d?$/.test(s)) {
      aspectRatio = s;
    } else {
      const m = /^(\d{2,5})[x×](\d{2,5})$/i.exec(s);
      if (m) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (w > 0 && h > 0) {
          rawSize = `${w}x${h}`;
          const best = STANDARD_RATIOS.find(([rw, rh]) => Math.abs(w / h / (rw / rh) - 1) < 0.04);
          if (best) aspectRatio = `${best[0]}:${best[1]}`;
          const longest = Math.max(w, h);
          if (!imageTier) {
            if (longest >= 3000) imageTier = "4K";
            else if (longest >= 1800) imageTier = "2K";
            else imageTier = "1K";
          }
        }
      }
    }
  }

  return { aspectRatio, imageTier, rawSize };
}

export function detectImageMime(base64Data, format) {
  if (typeof format === "string" && format.trim()) {
    const f = format.trim().toLowerCase().replace(/^image\//, "");
    return `image/${f === "jpg" ? "jpeg" : f}`;
  }
  const s = String(base64Data ?? "");
  if (s.startsWith("/9j/")) return "image/jpeg";
  if (s.startsWith("UklGR")) return "image/webp";
  if (s.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

export function parseDataUrlImage(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  const s = input.trim();
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (m) {
    const mimeType = m[1].toLowerCase();
    const data = m[2].replace(/\s+/g, "");
    return { mimeType, data, dataUrl: `data:${mimeType};base64,${data}` };
  }
  if (/^https?:\/\//i.test(s)) {
    return { url: s, dataUrl: s };
  }
  const clean = s.replace(/\s+/g, "");
  const mimeType = detectImageMime(clean);
  return { mimeType, data: clean, dataUrl: `data:${mimeType};base64,${clean}` };
}

export async function parseImageRequest(req) {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    const fields = {};
    const images = [];
    for (const [key, value] of form.entries()) {
      if (value && typeof value === "object" && typeof value.arrayBuffer === "function") {
        if (key === "image" || key === "image[]" || key === "images") {
          const buf = Buffer.from(await value.arrayBuffer());
          const data = buf.toString("base64");
          const mimeType = value.type && value.type.startsWith("image/") ? value.type : detectImageMime(data);
          images.push({ mimeType, data, dataUrl: `data:${mimeType};base64,${data}` });
        }
      } else if (typeof value === "string") {
        if (key === "image" || key === "image[]" || key === "images") {
          const parsed = parseDataUrlImage(value);
          if (parsed) images.push(parsed);
        } else if (value === "true" || value === "false") {
          fields[key] = value === "true";
        } else {
          fields[key] = value;
        }
      }
    }
    if (fields.n !== undefined) fields.n = Number(fields.n) || 1;
    if (fields.seed !== undefined) fields.seed = Number(fields.seed);
    return { ...fields, images };
  }

  let body;
  try {
    body = await req.json();
  } catch {
    throw problem(400, "Invalid JSON body for image generation request");
  }
  if (!isObj(body)) throw problem(400, "Image generation body must be a JSON object");

  const images = [];
  const rawImages = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
  for (const item of rawImages) {
    const str = typeof item === "string" ? item : item?.image_url ?? item?.url ?? item?.data;
    const parsed = parseDataUrlImage(str);
    if (parsed) images.push(parsed);
  }
  return { ...body, images };
}

export function buildNativeImagesBody(parsed) {
  const {
    model,
    prompt,
    n = 1,
    size,
    quality,
    background,
    output_format,
    output_compression,
    moderation,
    response_format,
    negative_prompt,
    seed,
    watermark,
    prompt_extend,
    num_inference_steps,
    images = [],
  } = parsed;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw problem(400, "Image generation requires a non-empty prompt");
  }

  const isGptImage = String(model ?? "").startsWith("openai/gpt-image-");
  const out = {
    model,
    prompt,
    n: num(n) ?? 1,
  };
  if (size) out.size = size;
  if (quality) out.quality = quality;
  if (background) out.background = background;
  if (output_format) out.output_format = output_format;
  if (output_compression !== undefined) out.output_compression = output_compression;
  if (moderation) out.moderation = moderation;
  if (negative_prompt) out.negative_prompt = negative_prompt;
  if (seed !== undefined) out.seed = Number(seed);
  if (watermark !== undefined) out.watermark = Boolean(watermark);
  if (prompt_extend !== undefined) out.prompt_extend = Boolean(prompt_extend);
  if (num_inference_steps !== undefined) out.num_inference_steps = Number(num_inference_steps);

  if (response_format) {
    if (!isGptImage || response_format !== "b64_json") out.response_format = response_format;
  } else if (!isGptImage) {
    out.response_format = "b64_json";
  }

  if (images.length > 0) {
    out.images = images.map((img) => ({ image_url: img.dataUrl }));
  }

  return out;
}

export function buildVertexImagenBody(parsed, record) {
  const {
    prompt,
    n = 1,
    size,
    resolution,
    aspect_ratio,
    aspectRatio: explicitRatio,
    quality,
    output_format,
    seed,
    negative_prompt,
    negativePrompt,
    watermark,
    addWatermark,
    prompt_extend,
    enhancePrompt,
    images = [],
  } = parsed;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw problem(400, "Image generation requires a non-empty prompt");
  }

  const supported = new Set((record?.supported_parameters ?? []).map((p) => String(p).toLowerCase()));
  const hasParam = (name) => !supported.size || supported.has(name.toLowerCase());

  const dims = parseImageDimensions(size, resolution);
  const ratio = explicitRatio ?? aspect_ratio ?? dims.aspectRatio;
  const tier = dims.imageTier;

  const instance = { prompt };
  if (images.length > 0) {
    instance.referenceImages = images
      .filter((img) => img.data)
      .map((img, idx) => ({
        referenceId: idx + 1,
        referenceType: "REFERENCE_TYPE_RAW",
        referenceImage: {
          bytesBase64Encoded: img.data,
          mimeType: img.mimeType || "image/png",
        },
      }));
  }

  const parameters = {};
  const count = num(n) ?? 1;
  if (supported.has("n") && !supported.has("samplecount")) {
    parameters.n = count;
  } else if (hasParam("sampleCount")) {
    parameters.sampleCount = count;
  }

  if ( dims.rawSize && supported.has("size") && !supported.has("aspectratio")) {
    parameters.size = dims.rawSize;
  } else if (ratio && hasParam("aspectRatio")) {
    parameters.aspectRatio = ratio;
  }

  if (tier) {
    if (supported.has("imagesize")) parameters.imageSize = tier;
    else if (supported.has("sampleimagesize")) parameters.sampleImageSize = tier;
  }

  const neg = negative_prompt ?? negativePrompt;
  if (typeof neg === "string" && neg.trim()) {
    if (supported.has("negative_prompt")) parameters.negative_prompt = neg.trim();
    else if (hasParam("negativePrompt")) parameters.negativePrompt = neg.trim();
  }

  if (seed !== undefined && Number.isFinite(Number(seed)) && hasParam("seed")) {
    parameters.seed = Number(seed);
  }

  const wm = watermark ?? addWatermark;
  if (wm !== undefined) {
    if (supported.has("watermark")) parameters.watermark = Boolean(wm);
    else if (hasParam("addWatermark")) parameters.addWatermark = Boolean(wm);
  }

  if (prompt_extend !== undefined && supported.has("prompt_extend")) {
    parameters.prompt_extend = Boolean(prompt_extend);
  }
  if (enhancePrompt !== undefined && supported.has("enhanceprompt")) {
    parameters.enhancePrompt = Boolean(enhancePrompt);
  }
  if (quality && supported.has("quality")) {
    parameters.quality = quality;
  }
  if (output_format && hasParam("outputMimeType")) {
    const fmt = String(output_format).toLowerCase();
    parameters.outputMimeType = `image/${fmt === "jpg" ? "jpeg" : fmt}`;
  }

  const body = { instances: [instance], parameters };
  if (tier && supported.has("sampleimagesize")) {
    body.sampleImageSize = tier;
  }
  return body;
}

export function buildGeminiImageBody(parsed) {
  const { prompt, size, resolution, aspect_ratio, aspectRatio: explicitRatio, seed, images = [] } = parsed;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw problem(400, "Image generation requires a non-empty prompt");
  }

  const dims = parseImageDimensions(size, resolution);
  const ratio = explicitRatio ?? aspect_ratio ?? dims.aspectRatio;
  const tier = dims.imageTier;

  const parts = [];
  for (const img of images) {
    if (img.data) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType || "image/png",
          data: img.data,
        },
      });
    }
  }
  parts.push({ text: prompt });

  const generationConfig = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  if (seed !== undefined && Number.isFinite(Number(seed))) {
    generationConfig.seed = Number(seed);
  }
  if (ratio || tier) {
    generationConfig.imageConfig = {
      ...(ratio ? { aspectRatio: ratio } : {}),
      ...(tier ? { imageSize: tier } : {}),
    };
  }

  return {
    contents: [{ role: "user", parts }],
    generationConfig,
  };
}

export function normalizeImagenResponse(payload) {
  const list = Array.isArray(payload?.predictions)
    ? payload.predictions
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  if (!list.length) {
    throw problem(502, payload?.error?.message || "ZenMux Imagen endpoint returned no predictions");
  }
  const data = [];
  for (const item of list) {
    if (typeof item?.bytesBase64Encoded === "string" && item.bytesBase64Encoded) {
      data.push({ b64_json: item.bytesBase64Encoded });
    } else if (typeof item?.b64_json === "string" && item.b64_json) {
      data.push({ b64_json: item.b64_json });
    } else if (typeof item?.url === "string" && item.url) {
      data.push({ url: item.url });
    } else if (typeof item?.gcsUri === "string" && /^https?:\/\//i.test(item.gcsUri)) {
      data.push({ url: item.gcsUri });
    } else if (item?.raiFilteredReason) {
      throw problem(400, `ZenMux filtered the image: ${item.raiFilteredReason}`);
    }
  }
  if (!data.length) {
    throw problem(502, "ZenMux Imagen endpoint returned no usable image data");
  }
  return {
    created: Math.floor(Date.now() / 1000),
    data,
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}

export function normalizeGeminiImageResponse(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const data = [];
  const texts = [];
  for (const cand of candidates) {
    const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    for (const part of parts) {
      if (part?.thought) continue;
      if (typeof part?.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
      if (typeof part?.inlineData?.data === "string" && part.inlineData.data) {
        data.push({ b64_json: part.inlineData.data });
      }
    }
  }
  if (!data.length) {
    const reason = candidates[0]?.finishReason || payload?.promptFeedback?.blockReason || "";
    const detail = texts.join(" ") || reason || "Gemini returned no image";
    throw problem(502, `ZenMux Gemini image generation failed: ${detail}`);
  }
  if (texts.length) {
    data[0].revised_prompt = texts.join("\n");
  }
  const usage = payload?.usageMetadata
    ? {
        input_tokens: payload.usageMetadata.promptTokenCount ?? 0,
        output_tokens: payload.usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: payload.usageMetadata.totalTokenCount ?? 0,
      }
    : undefined;
  return {
    created: Math.floor(Date.now() / 1000),
    data,
    ...(usage ? { usage } : {}),
  };
}

export async function handleImageRequest(req, {
  token,
  apiBase = API_BASE_URL,
  vertexBase = VERTEX_BASE_URL,
  findModel,
  fetchImpl = fetch,
} = {}) {
  const parsed = await parseImageRequest(req);
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (!model || !model.includes("/")) {
    throw problem(400, "Image generation requires a valid ZenMux vendor/model ID");
  }

  const record = findModel ? await findModel(model) : null;
  const protocol = record?.image_protocol ?? resolveImageProtocol(record ?? { id: model, supported_apis: [] });
  const [publisher, name] = model.split("/");

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  if (protocol === "images") {
    const isEdit = parsed.images?.length > 0;
    const url = `${apiBase}/images/${isEdit ? "edits" : "generations"}`;
    const body = buildNativeImagesBody(parsed);
    return fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }

  if (protocol === "gemini") {
    const url = `${vertexBase}/publishers/${publisher}/models/${name}:generateContent`;
    const body = buildGeminiImageBody(parsed);
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) return res;
    const payload = await res.json();
    return Response.json(normalizeGeminiImageResponse(payload), { status: 200 });
  }

  // protocol === "imagen" (:predict)
  const url = `${vertexBase}/publishers/${publisher}/models/${name}:predict`;
  const body = buildVertexImagenBody(parsed, record);
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) return res;
  const payload = await res.json();
  return Response.json(normalizeImagenResponse(payload), { status: 200 });
}
