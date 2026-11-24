import {
  ANTHROPIC_BASE_URL,
  API_BASE_URL,
  THINKING_BUDGETS,
  VERTEX_BASE_URL,
  isObj,
} from "../constants.mjs";

export function budgetForLevel(level) {
  const l = String(level ?? "").trim().toLowerCase();
  if (THINKING_BUDGETS[l] !== undefined) return THINKING_BUDGETS[l];
  return THINKING_BUDGETS.high;
}

export function effortLevelOf(body) {
  if (!isObj(body)) return undefined;
  for (const v of [body.reasoning_effort, body.reasoning?.effort, body.output_config?.effort, body.reasoningEffort]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizeTextRequestUrl(rawUrl, {
  apiBase = API_BASE_URL,
  anthropicBase = ANTHROPIC_BASE_URL,
  vertexBase = VERTEX_BASE_URL,
} = {}) {
  const u = new URL(String(rawUrl));
  const path = u.pathname;

  // Vertex Gemini path normalization: /models/{publisher}/{name}:{op} -> /publishers/{publisher}/models/{name}:{op}
  const geminiMatch = /\/models\/([^/]+)\/([^/:]+):(streamGenerateContent|generateContent)$/u.exec(path);
  if (geminiMatch) {
    const [, publisher, name, op] = geminiMatch;
    const next = new URL(`${vertexBase}/publishers/${publisher}/models/${name}:${op}`);
    next.search = u.search;
    if (op === "streamGenerateContent" && !next.searchParams.has("alt")) {
      next.searchParams.set("alt", "sse");
    }
    return { url: next.toString(), protocol: "gemini", publisher, name, op };
  }

  const pubMatch = /\/publishers\/([^/]+)\/models\/([^/:]+):(streamGenerateContent|generateContent)$/u.exec(path);
  if (pubMatch) {
    const [, publisher, name, op] = pubMatch;
    const next = new URL(`${vertexBase}/publishers/${publisher}/models/${name}:${op}`);
    next.search = u.search;
    if (op === "streamGenerateContent" && !next.searchParams.has("alt")) {
      next.searchParams.set("alt", "sse");
    }
    return { url: next.toString(), protocol: "gemini", publisher, name, op };
  }

  // Anthropic Messages path normalization (including requests relayed via `also` on a chat/responses base URL)
  if (/\/messages$/u.test(path)) {
    const next = new URL(`${anthropicBase}/messages`);
    next.search = u.search;
    return { url: next.toString(), protocol: "messages" };
  }

  // OpenAI Responses path normalization
  if (/\/responses$/u.test(path)) {
    const next = new URL(`${apiBase}/responses`);
    next.search = u.search;
    return { url: next.toString(), protocol: "responses" };
  }

  // OpenAI Chat Completions path normalization
  if (/\/chat\/completions$/u.test(path)) {
    const next = new URL(`${apiBase}/chat/completions`);
    next.search = u.search;
    return { url: next.toString(), protocol: "chat" };
  }

  return { url: u.toString(), protocol: "other" };
}

export function transformTextBody(rawBody, protocol, { selectedEffort, defaultEffort, store = false } = {}) {
  if (typeof rawBody !== "string" || !rawBody.trim()) return rawBody;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (!isObj(parsed)) return rawBody;

  let changed = false;
  const effectiveEffort = selectedEffort || effortLevelOf(parsed) || defaultEffort;

  if (protocol === "chat") {
    if (parsed.stream === true) {
      const so = isObj(parsed.stream_options) ? parsed.stream_options : {};
      if (so.include_usage !== true) {
        parsed.stream_options = { ...so, include_usage: true };
        changed = true;
      }
    }
    if (effectiveEffort && parsed.reasoning_effort !== effectiveEffort) {
      parsed.reasoning_effort = effectiveEffort;
      changed = true;
    }
  } else if (protocol === "responses") {
    if (parsed.store === undefined && store === true) {
      parsed.store = true;
      changed = true;
    } else if (parsed.store === true && store !== true) {
      delete parsed.store;
      changed = true;
    }
    if (effectiveEffort) {
      const r = isObj(parsed.reasoning) ? parsed.reasoning : {};
      if (r.effort !== effectiveEffort) {
        parsed.reasoning = { ...r, effort: effectiveEffort };
        changed = true;
      }
    }
  } else if (protocol === "messages") {
    const wantsThinking =
      effectiveEffort !== undefined ||
      parsed.thinking?.type === "adaptive" ||
      (parsed.thinking?.type === "enabled" && parsed.thinking?.budget_tokens === undefined);
    if (wantsThinking) {
      const budget = budgetForLevel(effectiveEffort);
      if (budget <= 0) {
        parsed.thinking = { type: "disabled" };
      } else {
        parsed.thinking = { type: "enabled", budget_tokens: budget };
        if (typeof parsed.max_tokens === "number" && parsed.max_tokens <= budget) {
          parsed.max_tokens = budget + 4096;
        }
      }
      changed = true;
    }
    if (isObj(parsed.output_config) && "effort" in parsed.output_config) {
      const { effort: _drop, ...rest } = parsed.output_config;
      if (Object.keys(rest).length) parsed.output_config = rest;
      else delete parsed.output_config;
      changed = true;
    }
  }

  return changed ? JSON.stringify(parsed) : rawBody;
}
