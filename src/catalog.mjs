import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_BASE_URL,
  API_BASE_URL,
  CURATED_CHAT_MODELS,
  CURATED_IMAGE_MODELS,
  CURATED_VIDEO_MODELS,
  EFFORTS,
  MODEL_SLUG_RE,
  NPM_PACKAGES,
  PROVIDER_ID,
  PUBLIC_API_BASE_URL,
  VERTEX_BASE_URL,
  isObj,
  num,
} from "./constants.mjs";

const LEVEL_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MODALITY_KINDS = ["text", "image", "audio", "video", "pdf"];

const PROTOCOL_ALIASES = new Map([
  ["chat", "chat"],
  ["chat.completions", "chat"],
  ["chat_completions", "chat"],
  ["openai", "chat"],
  ["responses", "responses"],
  ["response", "responses"],
  ["messages", "messages"],
  ["anthropic", "messages"],
  ["anthropic.messages", "messages"],
  ["gemini", "gemini"],
  ["generate", "gemini"],
]);

function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\s,|]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  return [];
}

export function releaseDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value) return value;
  }
  return undefined;
}

export function modelsDevCachePaths(env = process.env, platform = process.platform, home = homedir()) {
  const candidates = [];
  const add = (dir) => {
    const base = typeof dir === "string" ? dir.trim() : "";
    if (base) candidates.push(`${base.replace(/[\\/]+$/, "")}/magpie/models.json`);
  };
  add(env?.XDG_CACHE_HOME);
  if (home) add(`${home}/.cache`);
  if (platform === "win32") {
    add(env?.LOCALAPPDATA);
    if (home) add(`${home}/AppData/Local`);
  } else if (platform === "darwin" && home) {
    add(`${home}/Library/Caches`);
  }
  return [...new Set(candidates.map((p) => p.replace(/\\/g, "/")))];
}

let modelsDevState = { file: "", mtime: 0, models: {} };

export function readModelsDevSnapshot(env = process.env) {
  for (const file of modelsDevCachePaths(env)) {
    try {
      const st = statSync(file);
      if (modelsDevState.file === file && modelsDevState.mtime === st.mtimeMs) return modelsDevState.models;
      const data = JSON.parse(readFileSync(file, "utf8"));
      const provider = isObj(data?.[PROVIDER_ID]) ? data[PROVIDER_ID] : {};
      const models = isObj(provider.models) ? provider.models : {};
      modelsDevState = { file, mtime: st.mtimeMs, models };
      return models;
    } catch {
      // ignore missing snapshot
    }
  }
  return {};
}

export function modelsDevLevels(dev) {
  const levels = [];
  const options = Array.isArray(dev?.reasoning_options) ? dev.reasoning_options : [];
  for (const option of options) {
    if (!isObj(option) || option.type !== "effort") continue;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const level = typeof value === "string" ? value.trim() : "";
      if (!LEVEL_RE.test(level) || levels.includes(level)) continue;
      levels.push(level);
    }
  }
  return levels;
}

export function variantsForProtocol(protocol, levels = []) {
  if (protocol !== "chat" && protocol !== "responses") return undefined;
  const out = {};
  for (const level of Array.isArray(levels) ? levels : []) {
    const l = String(level ?? "").trim().toLowerCase();
    if (!LEVEL_RE.test(l) || Object.hasOwn(out, l)) continue;
    out[l] = { reasoningEffort: l };
  }
  return Object.keys(out).length ? out : undefined;
}

// Classify a normalized ZenMux catalog record into its primary functional kind:
// "chat" | "image" | "video" | "speech" | "transcription" | "embedding" | "rerank" | "decision"
export function classifyModel(record) {
  const out = splitList(record.output_modalities);
  const apis = record.supported_apis ?? [];
  if (out.includes("video")) return "video";
  if (out.includes("image")) return "image";
  if (out.includes("speech") || apis.includes("audio.speech")) return "speech";
  if (out.includes("transcription") || apis.includes("audio.transcriptions") || /(^|[/_.-])(asr|transcribe|stt)([/_.-]|$)/i.test(record.id)) {
    return "transcription";
  }
  if (out.includes("embeddings") || out.includes("embedding") || apis.includes("embeddings")) return "embedding";
  if (out.includes("rerank") || apis.includes("rerank")) return "rerank";
  if (out.includes("decisions") && !out.includes("text")) return "decision";
  return "chat";
}

// Determine which upstream image protocol an image model uses:
// "images" (/api/v1/images/generations) | "imagen" (/api/vertex-ai/v1/...:predict) | "gemini" (:generateContent)
export function resolveImageProtocol(record) {
  const apis = record.supported_apis ?? [];
  if (apis.includes("images")) return "images";
  if (apis.includes("gemini") || apis.includes("generate") || record.id.startsWith("google/gemini-")) return "gemini";
  return "imagen";
}

// Determine which upstream video protocol a video model uses:
// "native" (/api/v1/videos) | "vertex" (:predictLongRunning) | "interactions" (/api/v1/interactions)
export function resolveVideoProtocol(record) {
  const apis = record.supported_apis ?? [];
  if (apis.includes("interactions") || record.id.startsWith("google/gemini-omni-")) return "interactions";
  if (apis.includes("videos") || record.in_v1_models) return "native";
  return "vertex";
}

// Determine primary text protocol and secondary `also` AI SDK packages.
export function resolveTextProtocols(record, override = "auto") {
  const apis = record.supported_apis ?? [];
  const textProtos = [];
  for (const token of apis) {
    const p = PROTOCOL_ALIASES.get(token);
    if (p && !textProtos.includes(p)) textProtos.push(p);
  }
  if (!textProtos.length) textProtos.push("chat");

  if (override && override !== "auto" && NPM_PACKAGES[override]) {
    const others = textProtos.filter((p) => p !== override && NPM_PACKAGES[p]);
    return { primary: override, also: others.map((p) => NPM_PACKAGES[p]) };
  }

  const id = record.id.toLowerCase();
  let preferred = textProtos[0];
  if (id.startsWith("anthropic/claude-") && textProtos.includes("messages")) {
    preferred = "messages";
  } else if (/^openai\/(?:(?:gpt|chatgpt|codex|chat)-|o\d+(?:[.-]|$))/u.test(id) && textProtos.includes("responses")) {
    preferred = "responses";
  } else if (record.reasoning && preferred === "messages") {
    const nonMessages = textProtos.find((p) => p === "responses" || p === "chat");
    if (nonMessages) preferred = nonMessages;
  } else if (preferred === "gemini" && (textProtos.includes("chat") || textProtos.includes("responses") || textProtos.includes("messages"))) {
    // Keep chat/responses/messages as primary for Magpie tool/reasoning compatibility,
    // while direct Gemini requests are still routed by fetch().
    preferred = textProtos.find((p) => p !== "gemini") ?? "gemini";
  }

  const also = textProtos
    .filter((p) => p !== preferred && (p === "chat" || p === "responses" || p === "messages" || p === "gemini"))
    .map((p) => NPM_PACKAGES[p]);
  return { primary: preferred, also };
}

export function normalizeCatalogEntries({ availableList = [], v1Models = [], vertexModels = [] } = {}) {
  const map = new Map();

  const ensure = (id) => {
    if (!id || typeof id !== "string" || !MODEL_SLUG_RE.test(id)) return null;
    let rec = map.get(id);
    if (!rec) {
      rec = {
        id,
        display_name: id,
        input_modalities: ["text"],
        output_modalities: ["text"],
        context_length: 0,
        max_tokens: 0,
        reasoning: false,
        supported_apis: [],
        supported_parameters: [],
        endpoint_slugs: [],
        pricings: null,
        discount_factor: undefined,
        release_date: undefined,
        in_v1_models: false,
        in_vertex_models: false,
      };
      map.set(id, rec);
    }
    return rec;
  };

  for (const row of Array.isArray(availableList) ? availableList : []) {
    if (!isObj(row)) continue;
    const id = row.slug ?? row.model_slug ?? row.id;
    const rec = ensure(id);
    if (!rec) continue;
    if (typeof row.name === "string" && row.name.trim()) rec.display_name = row.name.trim();
    const inMods = splitList(row.input_modalities);
    if (inMods.length) rec.input_modalities = inMods;
    const outMods = splitList(row.output_modalities);
    if (outMods.length) rec.output_modalities = outMods;
    if (num(row.context_length) > 0) rec.context_length = num(row.context_length);
    if (num(row.max_completion_tokens) > 0) rec.max_tokens = num(row.max_completion_tokens);
    if (row.supports_reasoning === true || num(row.supports_reasoning) > 0) rec.reasoning = true;
    const date = releaseDate(row.publish_time);
    if (date) rec.release_date = date;
    const disc = num(row.pricing_discount);
    if (disc !== undefined && disc > 0 && disc < 1) rec.discount_factor = disc;

    const apis = new Set(rec.supported_apis);
    for (const a of splitList(row.suitable_api)) apis.add(a);
    const params = new Set(rec.supported_parameters);
    for (const p of splitList(row.supported_parameters)) params.add(p);
    const slugs = new Set(rec.endpoint_slugs);
    if (typeof row.endpoint_slug === "string" && row.endpoint_slug) slugs.add(row.endpoint_slug);

    for (const ep of Array.isArray(row.endpoints) ? row.endpoints : []) {
      if (!isObj(ep)) continue;
      for (const a of splitList(ep.suitable_api)) apis.add(a);
      for (const p of splitList(ep.supported_parameters)) params.add(p);
      if (typeof ep.endpoint_slug === "string" && ep.endpoint_slug) slugs.add(ep.endpoint_slug);
      if (ep.supports_reasoning === true || num(ep.supports_reasoning) > 0) rec.reasoning = true;
      if (num(ep.context_length) > rec.context_length) rec.context_length = num(ep.context_length);
      if (num(ep.max_completion_tokens) > rec.max_tokens) rec.max_tokens = num(ep.max_completion_tokens);
    }

    rec.supported_apis = [...apis];
    rec.supported_parameters = [...params];
    rec.endpoint_slugs = [...slugs];

    const promptPrice = num(row.pricing_prompt);
    const compPrice = num(row.pricing_completion);
    if ((promptPrice !== undefined && promptPrice > 0) || (compPrice !== undefined && compPrice > 0)) {
      rec.pricings ??= {};
      if (promptPrice !== undefined) rec.pricings.prompt = [{ value: promptPrice, unit: "perMTokens", currency: "USD" }];
      if (compPrice !== undefined) rec.pricings.completion = [{ value: compPrice, unit: "perMTokens", currency: "USD" }];
    }
  }

  for (const row of Array.isArray(v1Models) ? v1Models : []) {
    if (!isObj(row)) continue;
    const rec = ensure(row.id);
    if (!rec) continue;
    rec.in_v1_models = true;
    if (typeof row.display_name === "string" && row.display_name.trim()) rec.display_name = row.display_name.trim();
    const inMods = splitList(row.input_modalities);
    if (inMods.length) rec.input_modalities = inMods;
    const outMods = splitList(row.output_modalities);
    if (outMods.length) rec.output_modalities = outMods;
    if (num(row.context_length) > 0) rec.context_length = num(row.context_length);
    if (num(row.max_tokens) > 0) rec.max_tokens = num(row.max_tokens);
    if (row.capabilities?.reasoning === true) rec.reasoning = true;
    if (isObj(row.pricings)) rec.pricings = row.pricings;
    const date = releaseDate(row.publish_time);
    if (date) rec.release_date ??= date;
    if (rec.output_modalities.includes("image") && !rec.supported_apis.includes("images")) {
      rec.supported_apis.push("images");
    }
    if (rec.output_modalities.includes("video") && !rec.supported_apis.includes("videos")) {
      rec.supported_apis.push("videos");
    }
  }

  for (const row of Array.isArray(vertexModels) ? vertexModels : []) {
    if (!isObj(row)) continue;
    const id = typeof row.name === "string"
      ? row.name.replace(/^publishers\/([^/]+)\/models\//, "$1/").replace(/^models\//, "")
      : "";
    const rec = ensure(id);
    if (!rec) continue;
    rec.in_vertex_models = true;
    if (typeof row.displayName === "string" && row.displayName.trim()) rec.display_name = row.displayName.trim();
    const inMods = splitList(row.inputModalities);
    if (inMods.length) rec.input_modalities = inMods;
    const outMods = splitList(row.outputModalities);
    if (outMods.length) rec.output_modalities = outMods;
    if (num(row.inputTokenLimit) > 0 && !rec.context_length) rec.context_length = num(row.inputTokenLimit);
    if (num(row.outputTokenLimit) > 0 && !rec.max_tokens) rec.max_tokens = num(row.outputTokenLimit);
    if (row.thinking === true) rec.reasoning = true;
    if (isObj(row.pricings) && !rec.pricings) rec.pricings = row.pricings;
    const date = releaseDate(row.publish_time);
    if (date) rec.release_date ??= date;
  }

  for (const rec of map.values()) {
    rec.kind = classifyModel(rec);
    if (rec.kind === "image") rec.image_protocol = resolveImageProtocol(rec);
    else if (rec.kind === "video") rec.video_protocol = resolveVideoProtocol(rec);
  }

  return sortCatalogRecords([...map.values()]);
}

const KIND_ORDER = {
  chat: 1,
  image: 2,
  video: 3,
  speech: 4,
  transcription: 5,
  embedding: 6,
  rerank: 7,
  decision: 8,
};

const CURATED_CHAT_RANK = new Map(CURATED_CHAT_MODELS.map((id, idx) => [id, idx]));
const CURATED_IMAGE_RANK = new Map(CURATED_IMAGE_MODELS.map((id, idx) => [id, idx]));
const CURATED_VIDEO_RANK = new Map(CURATED_VIDEO_MODELS.map((id, idx) => [id, idx]));

// Sort catalog records so that:
// 1. Chat models come first, with the 24 CURATED_CHAT_MODELS at the top (so Magpie's
//    default Exposed() picks only those 24 flagships and leaves legacy models unchecked).
// 2. Remaining chat models sort newest first by release_date.
// 3. Image models (36) sort with CURATED_IMAGE_MODELS first, then newest first.
// 4. Video models (24) sort with CURATED_VIDEO_MODELS first, then newest first.
// 5. Speech, transcription, embedding, rerank, and pure decision models follow.
export function sortCatalogRecords(records) {
  return [...records].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 99;
    const kb = KIND_ORDER[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;

    if (a.kind === "chat") {
      const ra = CURATED_CHAT_RANK.get(a.id);
      const rb = CURATED_CHAT_RANK.get(b.id);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      }
    } else if (a.kind === "image") {
      const ra = CURATED_IMAGE_RANK.get(a.id);
      const rb = CURATED_IMAGE_RANK.get(b.id);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      }
    } else if (a.kind === "video") {
      const ra = CURATED_VIDEO_RANK.get(a.id);
      const rb = CURATED_VIDEO_RANK.get(b.id);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      }
    }

    const da = a.release_date ?? "";
    const db = b.release_date ?? "";
    if (da !== db) return db.localeCompare(da);
    return a.id.localeCompare(b.id);
  });
}

export function costOf(record) {
  const p = isObj(record?.pricings) ? record.pricings : {};
  const val = (k) => {
    const arr = Array.isArray(p[k]) ? p[k] : [];
    for (const item of arr) {
      const v = num(item?.value);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const input = val("prompt");
  const output = val("completion");
  const cacheRead = val("input_cache_read");
  const cacheWrite = val("input_cache_write");
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(cacheRead !== undefined || cacheWrite !== undefined
      ? {
          cache: {
            ...(cacheRead !== undefined ? { read: cacheRead } : {}),
            ...(cacheWrite !== undefined ? { write: cacheWrite } : {}),
          },
        }
      : {}),
  };
}

export function apiForProtocol(protocol, { chatApi = API_BASE_URL, anthropicApi = ANTHROPIC_BASE_URL, vertexApi = VERTEX_BASE_URL } = {}) {
  switch (protocol) {
    case "messages":
      return { url: anthropicApi, npm: NPM_PACKAGES.messages };
    case "responses":
      return { url: chatApi, npm: NPM_PACKAGES.responses };
    case "gemini":
      return { url: vertexApi, npm: NPM_PACKAGES.gemini };
    default:
      return { url: chatApi, npm: NPM_PACKAGES.chat };
  }
}

function modalityFlags(list, allowed = MODALITY_KINDS) {
  const set = new Set(Array.isArray(list) ? list : []);
  return Object.fromEntries(
    MODALITY_KINDS.map((k) => [
      k,
      allowed.includes(k) && (set.has(k) || (k === "pdf" && set.has("file"))),
    ]),
  );
}

// Convert a normalized catalog record into the OpenCode / Magpie plugin Model row.
export function toMagpieModel(record, base = {}, {
  subscription = false,
  protocolOption = "auto",
  chatApi = API_BASE_URL,
  anthropicApi = ANTHROPIC_BASE_URL,
  vertexApi = VERTEX_BASE_URL,
  dev,
} = {}) {
  const b = isObj(base) ? base : {};
  const d = isObj(dev) ? dev : undefined;
  const kind = record.kind ?? classifyModel(record);

  const inputFlags = {
    ...modalityFlags(record.input_modalities),
    text: record.input_modalities.includes("text") || kind === "chat" || kind === "image" || kind === "video" || kind === "speech" || kind === "embedding" || kind === "rerank" || kind === "decision",
  };

  let outputFlags;
  let api;
  let also = [];
  let decides = false;

  if (kind === "image") {
    // Declare all 36 image models as images-only on @ai-sdk/openai-compatible so
    // Magpie's DrawersOf() and viaFor() route all 36 through /v1/images/{generations,edits},
    // where our fetch() dispatches images, Vertex Imagen :predict, and Gemini Image.
    outputFlags = { text: false, image: true, audio: false, video: false, pdf: false };
    api = { id: record.id, url: chatApi, npm: NPM_PACKAGES.chat };
  } else if (kind === "video") {
    // Declare all 24 video models with output.video = true (and text: false so they
    // don't consume default chat slots) for Magpie's VideomakersOf().
    outputFlags = { text: false, image: false, audio: false, video: true, pdf: false };
    api = { id: record.id, url: chatApi, npm: NPM_PACKAGES.chat };
  } else if (kind === "speech") {
    outputFlags = { text: false, image: false, audio: true, video: false, pdf: false };
    api = { id: record.id, url: chatApi, npm: NPM_PACKAGES.chat };
  } else if (kind === "transcription" || kind === "embedding" || kind === "rerank") {
    // OutputsSaid = true with all booleans false keeps ASR, Embeddings, and Rerank
    // out of chat model pickers (pluginTalks) while keeping them in Account.Models.
    outputFlags = { text: false, image: false, audio: false, video: false, pdf: false };
    api = { id: record.id, url: chatApi, npm: NPM_PACKAGES.chat };
  } else if (kind === "decision") {
    outputFlags = { text: true, image: false, audio: false, video: false, pdf: false };
    api = { id: record.id, url: chatApi, npm: NPM_PACKAGES.chat };
    decides = true;
  } else {
    outputFlags = { text: true, image: false, audio: false, video: false, pdf: false };
    const resolved = resolveTextProtocols(record, protocolOption);
    api = { id: record.id, ...apiForProtocol(resolved.primary, { chatApi, anthropicApi, vertexApi }) };
    also = resolved.also;
  }

  const reasoning = kind === "chat" && (record.reasoning || d?.reasoning === true || b?.reasoning === true);
  const devLevels = modelsDevLevels(d);
  const levels = devLevels.length ? devLevels : reasoning ? Object.keys(EFFORTS) : [];
  const protocolKey = api.npm === NPM_PACKAGES.responses ? "responses" : api.npm === NPM_PACKAGES.messages ? "messages" : "chat";
  const variants = reasoning ? variantsForProtocol(protocolKey, levels) : undefined;

  const context = num(b?.limit?.context) ?? num(d?.limit?.context) ?? (record.context_length > 0 ? record.context_length : 0);
  const output = num(b?.limit?.output) ?? num(d?.limit?.output) ?? (record.max_tokens > 0 ? record.max_tokens : 0);
  const cost = subscription ? { input: 0, output: 0 } : costOf(record) ?? b?.cost;
  const discount = record.discount_factor;

  return {
    id: record.id,
    providerID: PROVIDER_ID,
    name: record.display_name || b?.name || d?.name || record.id,
    api,
    ...(also.length ? { also } : {}),
    status: "active",
    headers: {},
    options: {},
    ...(cost ? { cost } : {}),
    ...(discount !== undefined && discount > 0 && discount < 1 ? { rate: discount, rateWas: 1 } : {}),
    ...(record.release_date ? { release_date: record.release_date } : {}),
    ...(decides ? { decides: true } : {}),
    limit: {
      context,
      output,
    },
    capabilities: {
      temperature: kind === "chat",
      reasoning,
      attachment: inputFlags.image || inputFlags.audio || inputFlags.video || inputFlags.pdf,
      toolcall: kind === "chat",
      input: inputFlags,
      output: outputFlags,
    },
    modalities: {
      input: MODALITY_KINDS.filter((k) => inputFlags[k]),
      output: MODALITY_KINDS.filter((k) => outputFlags[k]),
    },
    ...(variants ? { variants } : {}),
  };
}

export function planModelSets(plans) {
  const out = new Map();
  for (const p of Array.isArray(plans) ? plans : []) {
    const key = typeof p?.planKey === "string" ? p.planKey.trim().toLowerCase() : "";
    if (!key) continue;
    const set = new Set();
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const slug = typeof m?.model_slug === "string" ? m.model_slug : typeof m?.slug === "string" ? m.slug : "";
      if (slug) set.add(slug);
    }
    out.set(key, set);
  }
  return out;
}

export function parsePatternList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  if (isObj(v)) return Object.keys(v);
  return [];
}

export function matchesPattern(id, pattern) {
  const p = String(pattern ?? "").trim();
  if (!p) return false;
  if (p === "*") return true;
  if (!p.includes("*")) return p.endsWith("/") ? id.startsWith(p) : id === p;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(id);
}

export function createCatalogManager({
  directory = process.cwd(),
  apiBase = API_BASE_URL,
  vertexBetaBase = `${ new URL(API_BASE_URL).origin }/api/vertex-ai/v1beta`,
  publicApiBase = PUBLIC_API_BASE_URL,
  fetchImpl = fetch,
  ttlMs = 5 * 60 * 1000,
} = {}) {
  const cacheDir = join(directory, "zenmux-catalog-cache");
  const cacheFile = join(cacheDir, "catalog-v1.json");
  let memory = null;
  let expiresAt = 0;
  let pending = null;
  let planCache = { expiresAt: 0, sets: null };

  async function fetchJson(url, { token, signal, timeoutMs = 15_000 } = {}) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers, signal: sig });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, body });
    }
    return body;
  }

  async function saveSnapshot(records) {
    const tmp = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify({ version: 1, timestamp: Date.now(), records }), { mode: 0o600 });
      await rename(tmp, cacheFile);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async function loadSnapshot() {
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8"));
      if (raw?.version === 1 && Array.isArray(raw.records) && raw.records.length) {
        return raw.records;
      }
    } catch {
      // ignore missing/corrupt snapshot
    }
    return null;
  }

  async function refresh({ token, signal } = {}) {
    const [availRes, v1Res, vertexRes] = await Promise.allSettled([
      fetchJson(`${publicApiBase}/frontend/model/available/list`, { signal }),
      fetchJson(`${apiBase}/models`, { token, signal }),
      fetchJson(`${vertexBetaBase}/models`, { token, signal }),
    ]);

    const availableList = availRes.status === "fulfilled" && Array.isArray(availRes.value?.data) ? availRes.value.data : [];
    const v1Models = v1Res.status === "fulfilled" && Array.isArray(v1Res.value?.data) ? v1Res.value.data : [];
    const vertexModels = vertexRes.status === "fulfilled" && Array.isArray(vertexRes.value?.models) ? vertexRes.value.models : [];

    if (!availableList.length && !v1Models.length && !vertexModels.length) {
      const snap = await loadSnapshot();
      if (snap) {
        memory = new Map(snap.map((r) => [r.id, r]));
        expiresAt = Date.now() + 15_000;
        return memory;
      }
      throw v1Res.status === "rejected" ? v1Res.reason : new Error("ZenMux catalog endpoints returned no models");
    }

    const records = normalizeCatalogEntries({ availableList, v1Models, vertexModels });
    memory = new Map(records.map((r) => [r.id, r]));
    const fullSuccess = availableList.length > 0 && v1Models.length > 0;
    expiresAt = Date.now() + (fullSuccess ? ttlMs : 20_000);
    void saveSnapshot(records);
    return memory;
  }

  async function getCatalog({ token, signal, force = false } = {}) {
    if (!force && memory && Date.now() < expiresAt) return memory;
    if (pending) return pending;
    pending = refresh({ token, signal }).finally(() => {
      pending = null;
    });
    return pending;
  }

  async function getPlanSets({ signal } = {}) {
    if (planCache.sets && Date.now() < planCache.expiresAt) return planCache.sets;
    const body = await fetchJson(`${publicApiBase}/subscription/public/get_all_plans`, { signal });
    const sets = planModelSets(body?.data);
    if (sets.size > 0) {
      planCache = { sets, expiresAt: Date.now() + ttlMs };
    }
    return sets;
  }

  return {
    getCatalog,
    getPlanSets,
    findModel: async (id, opts) => {
      const cat = memory ?? (await getCatalog(opts));
      return cat.get(id);
    },
  };
}
