import {
  ANTHROPIC_BASE_URL,
  API_BASE_URL,
  ANY_KEY_RE,
  CURATED_CHAT_MODELS,
  CURATED_IMAGE_MODELS,
  CURATED_VIDEO_MODELS,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_ORIGIN,
  LEGACY_IMAGE_MODELS,
  LEGACY_KEY_RE,
  LEGACY_VIDEO_MODELS,
  MANAGEMENT_BASE_URL,
  MANAGEMENT_KEY_RE,
  NPM_PACKAGES,
  PROVIDER_ID,
  PROVIDER_NAME,
  PUBLIC_API_BASE_URL,
  VERTEX_BASE_URL,
  VERTEX_BETA_BASE_URL,
  isObj,
  problem,
} from "./src/constants.mjs";
import {
  DEFAULT_CLIENT_ID as OAUTH_CLIENT_ID,
  beginAuthorization,
  refreshAccessToken,
} from "./src/oauth.mjs";
import {
  bearerOf,
  billingKindOf,
  fetchAccountUsage,
  fetchManagementJson,
  isOAuth,
  isPaygKey,
  isSubscriptionKey,
  managementKeyOf,
  paygToUsage,
  subscriptionToUsage,
} from "./src/usage.mjs";
import {
  classifyModel,
  createCatalogManager,
  matchesPattern,
  normalizeCatalogEntries,
  parsePatternList,
  planModelSets,
  readModelsDevSnapshot,
  resolveImageProtocol,
  resolveTextProtocols,
  resolveVideoProtocol,
  sortCatalogRecords,
  toMagpieModel,
} from "./src/catalog.mjs";
import { normalizeTextRequestUrl, transformTextBody } from "./src/protocols/text.mjs";
import { handleImageRequest } from "./src/protocols/images.mjs";
import { createVideoHandler } from "./src/protocols/videos.mjs";
import { handleSpeechRequest, handleTranscriptionRequest } from "./src/protocols/audio.mjs";
import { handleRerankRequest, handleSystemOneRequest } from "./src/protocols/retrieval.mjs";

const CURATED_ALL_SET = new Set([
  ...CURATED_CHAT_MODELS,
  ...CURATED_IMAGE_MODELS,
  ...CURATED_VIDEO_MODELS,
]);

function isKeyRefusal(status, text) {
  if (status === 401) return true;
  if (status !== 403) return false;
  const s = String(text ?? "");
  return /api[_ -]?key|legacy key|upgrade window|credential|sign[- ]?in|token/i.test(s) && !/model/i.test(s);
}

async function annotateSignInStatus(res) {
  if (!res || (res.status !== 401 && res.status !== 403)) return res;
  let text = "";
  try {
    text = await res.clone().text();
  } catch {
    return res;
  }
  if (!isKeyRefusal(res.status, text)) return res;
  const headers = new Headers(res.headers);
  headers.set("x-magpie-sign-in", "expired");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function ZenMuxPlugin(input = {}, pluginOptions = {}) {
  const directory = input?.directory || process.cwd();
  const apiBase = (process.env.ZENMUX_API_BASE || pluginOptions.apiBase || API_BASE_URL).replace(/\/+$/, "");
  const anthropicBase = (
    process.env.ZENMUX_ANTHROPIC_API_BASE ||
    pluginOptions.anthropicBase ||
    `${new URL(apiBase).origin}/api/anthropic/v1`
  ).replace(/\/+$/, "");
  const vertexBase = (
    process.env.ZENMUX_VERTEX_API_BASE ||
    pluginOptions.vertexBase ||
    `${new URL(apiBase).origin}/api/vertex-ai/v1`
  ).replace(/\/+$/, "");
  const vertexBetaBase = (
    process.env.ZENMUX_VERTEX_BETA_API_BASE ||
    pluginOptions.vertexBetaBase ||
    `${new URL(apiBase).origin}/api/vertex-ai/v1beta`
  ).replace(/\/+$/, "");
  const managementBase = (
    process.env.ZENMUX_MANAGEMENT_API_BASE ||
    pluginOptions.managementBase ||
    MANAGEMENT_BASE_URL
  ).replace(/\/+$/, "");
  const publicApiBase = (
    process.env.ZENMUX_PUBLIC_API_BASE ||
    pluginOptions.publicApiBase ||
    PUBLIC_API_BASE_URL
  ).replace(/\/+$/, "");
  const oauthOrigin = (process.env.ZENMUX_OAUTH_ORIGIN || pluginOptions.oauthOrigin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const oauthClientId = process.env.ZENMUX_OAUTH_CLIENT_ID || pluginOptions.oauthClientId || OAUTH_CLIENT_ID;
  const fetchImpl = pluginOptions.fetchImpl || fetch;

  function currentOptions() {
    const live = typeof input?.magpie?.options === "function" ? input.magpie.options(PROVIDER_ID) : undefined;
    const cfg = input?.config?.provider?.[PROVIDER_ID]?.options;
    return {
      ...(isObj(cfg) ? cfg : {}),
      ...(isObj(live) ? live : {}),
      ...(isObj(pluginOptions) ? pluginOptions : {}),
    };
  }

  const userOptions = currentOptions();
  const includePatterns = parsePatternList(userOptions.include ?? userOptions.models);
  const excludePatterns = parsePatternList(userOptions.exclude ?? userOptions.blacklist);
  const curatedOnly = userOptions.curatedOnly === true;
  const allModels = userOptions.allModels === true;
  const protocolOption = (() => {
    const raw = typeof userOptions.protocol === "string" ? userOptions.protocol.trim().toLowerCase() : "";
    return ["chat", "responses", "messages", "gemini", "auto"].includes(raw) ? raw : "auto";
  })();
  const defaultEffort = typeof userOptions.reasoningEffort === "string" && userOptions.reasoningEffort.trim()
    ? userOptions.reasoningEffort.trim().toLowerCase()
    : undefined;
  const storeResponses = userOptions.store === true;

  const catalogManager = createCatalogManager({
    directory,
    apiBase,
    vertexBetaBase,
    publicApiBase,
    fetchImpl,
  });

  const handleVideoRequest = createVideoHandler({
    directory,
    apiBase,
    vertexBase,
    findModel: (id, opts) => catalogManager.findModel(id, opts),
    fetchImpl,
  });

  function isModelAllowed(record, opts = currentOptions()) {
    if (!record || !record.id) return false;
    const exc = parsePatternList(opts.exclude ?? opts.blacklist);
    const inc = parsePatternList(opts.include ?? opts.models);
    if (exc.some((p) => matchesPattern(record.id, p))) return false;
    if (inc.length > 0) return inc.some((p) => matchesPattern(record.id, p));
    if (opts.curatedOnly === true && ["chat", "image", "video"].includes(record.kind)) {
      return CURATED_ALL_SET.has(record.id);
    }
    return true;
  }

  async function resolveBuilderPlanTier(auth, { signal } = {}) {
    const explicit = typeof userOptions.plan === "string" ? userOptions.plan.trim().toLowerCase() : "";
    if (["starter", "pro", "max", "ultra"].includes(explicit)) return explicit;
    if (explicit === "payg" || explicit === "all") return "";

    const kind = billingKindOf(auth, userOptions);
    if (kind === "payg") return "";

    const mgmtKey = managementKeyOf(auth) || (typeof userOptions.managementKey === "string" ? userOptions.managementKey.trim() : "");
    if (!mgmtKey) return "";

    try {
      const res = await fetchManagementJson("subscription/detail", mgmtKey, {
        baseUrl: managementBase,
        fetchImpl,
        signal,
      });
      const tier = typeof res.body?.data?.plan?.tier === "string" ? res.body.data.plan.tier.trim().toLowerCase() : "";
      if (["starter", "pro", "max", "ultra"].includes(tier)) return tier;
    } catch {
      // fail open when management endpoint is unreachable
    }
    return "";
  }

  async function verifyApiKey(key, { signal } = {}) {
    const deadline = AbortSignal.timeout(20_000);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const probeModels = [
      "deepseek/deepseek-v4.1-flash",
      "google/gemini-4-hydrogen",
      "openai/gpt-6.1-terra",
      "anthropic/claude-fable-5.2",
    ];
    let lastStatus = 0;
    let lastMsg = "";
    for (const model of probeModels) {
      try {
        const res = await fetchImpl(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: false,
          }),
          signal: sig,
        });
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const msg = parsed?.error?.message || parsed?.message || text.slice(0, 200);
        if (res.ok || res.status === 429 || res.status === 402 || [400, 404, 422].includes(res.status)) {
          return { ok: true, model };
        }
        if (res.status === 403 && /model/i.test(msg)) {
          continue;
        }
        return { ok: false, status: res.status, message: msg };
      } catch (err) {
        signal?.throwIfAborted();
        lastMsg = err?.message || "network error";
      }
    }
    return { ok: false, status: lastStatus, network: !lastStatus, message: lastMsg || "Could not verify ZenMux API key" };
  }

  async function handlePluginFetch(token, inputUrl, init = {}) {
    const req = new Request(inputUrl, init);
    const headers = new Headers(req.headers);
    const selectedEffort = headers.get("x-magpie-effort")?.trim().toLowerCase();

    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("x-magpie-")) headers.delete(name);
      if (name.toLowerCase() === "x-goog-api-key") headers.delete(name);
    }
    if (token) headers.set("authorization", `Bearer ${token}`);

    const urlObj = new URL(req.url);
    const pathname = urlObj.pathname;

    try {
      // 1. Video Generation: POST /v1/videos, GET /v1/videos/:id, GET /v1/videos/:id/content
      const videoMatch = /\/videos(?:\/([^/]+)(\/content)?)?$/u.exec(pathname);
      if (videoMatch) {
        return await handleVideoRequest(new Request(req, { headers }), videoMatch, { token });
      }

      // 2. Image Generation & Editing: POST /v1/images/generations, POST /v1/images/edits
      if (/\/images\/(generations|edits)$/u.test(pathname)) {
        return await handleImageRequest(new Request(req, { headers }), {
          token,
          apiBase,
          vertexBase,
          findModel: (id) => catalogManager.findModel(id, { token, signal: req.signal }),
          fetchImpl,
        });
      }

      // 3. Text-to-Speech: POST /v1/audio/speech
      if (/\/audio\/speech$/u.test(pathname)) {
        return await handleSpeechRequest(new Request(req, { headers }), {
          token,
          apiBase,
          fetchImpl,
        });
      }

      // 4. Speech-to-Text (ASR): POST /v1/audio/transcriptions & /v1/audio/translations
      if (/\/audio\/(transcriptions|translations)$/u.test(pathname)) {
        return await handleTranscriptionRequest(new Request(req, { headers }), {
          token,
          apiBase,
          findModel: (id) => catalogManager.findModel(id, { token, signal: req.signal }),
          fetchImpl,
        });
      }

      // 5. Rerank: POST /v1/rerank
      if (/\/rerank$/u.test(pathname)) {
        return await handleRerankRequest(new Request(req, { headers }), {
          token,
          apiBase,
          fetchImpl,
        });
      }

      // 6. System One / Decisions: POST /v1/systemone & /v1/decisions
      if (/\/(systemone|decisions)$/u.test(pathname)) {
        return await handleSystemOneRequest(new Request(req, { headers }), {
          token,
          apiBase,
          findModel: (id) => catalogManager.findModel(id, { token, signal: req.signal }),
          fetchImpl,
        });
      }

      // 7. Embeddings: POST /v1/embeddings
      if (/\/embeddings$/u.test(pathname)) {
        return await fetchImpl(`${apiBase}/embeddings`, {
          method: req.method,
          headers,
          body: init?.body ?? req.body,
          signal: req.signal,
        });
      }

      // 8. Text & Multimodal Chat (Chat Completions, Responses, Anthropic Messages, Vertex Gemini)
      const normalized = normalizeTextRequestUrl(req.url, { apiBase, anthropicBase, vertexBase });
      if (normalized.protocol === "messages") {
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
        headers.delete("x-api-key");
      }

      let body = init?.body;
      if (typeof body === "string") {
        body = transformTextBody(body, normalized.protocol, {
          selectedEffort,
          defaultEffort,
          store: storeResponses,
        });
      }

      const res = await fetchImpl(normalized.url, {
        method: req.method,
        headers,
        body,
        signal: req.signal,
      });
      return await annotateSignInStatus(res);
    } catch (err) {
      const status = err?.status >= 400 && err?.status <= 599
        ? err.status
        : ["TimeoutError", "AbortError"].includes(err?.name)
          ? 504
          : 502;
      return Response.json(
        { error: { message: err?.message || "ZenMux request failed" } },
        { status, headers: { "x-magpie-sign-in": "kept" } },
      );
    }
  }

  return {
    async config(config) {
      if (!isObj(config)) return;
      config.provider ??= {};
      const existing = isObj(config.provider[PROVIDER_ID]) ? config.provider[PROVIDER_ID] : {};
      config.provider[PROVIDER_ID] = {
        ...existing,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? NPM_PACKAGES.chat,
        api: existing.api ?? apiBase,
        decide: true,
        searches: true,
        models: {
          ...DEFAULT_FALLBACK_MODELS,
          ...(isObj(existing.models) ? existing.models : {}),
        },
      };
    },

    auth: {
      provider: PROVIDER_ID,
      rotating: true,
      maxConcurrency: 2,
      options: [
        {
          key: "curatedOnly",
          label: "Curated flagship models only",
          description: "List only the latest flagship chat, image and video models in the picker (hide older generations). When off (default), all 257 models are available in the picker and only the 24 curated flagships are selected by default.",
          default: false,
          filtersModels: true,
        },
        {
          key: "protocol",
          label: "Primary text protocol",
          description: "Auto chooses the native protocol per model from ZenMux's catalog and enables zero-translation pass-through on secondary protocols.",
          default: "auto",
          choices: [
            { value: "auto", label: "Auto (per model + multi-protocol pass-through)" },
            { value: "chat", label: "OpenAI Chat Completions" },
            { value: "responses", label: "OpenAI Responses" },
            { value: "messages", label: "Anthropic Messages" },
          ],
          filtersModels: true,
        },
        {
          key: "allModels",
          label: "Ignore Builder Plan tier filter",
          description: "Show every ZenMux model even on a Starter/Max Builder Plan subscription.",
          default: false,
          filtersModels: true,
        },
      ],

      methods: [
        {
          type: "api",
          label: "ZenMux API Key (Pay As You Go or Builder Plan)",
          keyless: true,
          prompts: [
            {
              type: "password",
              key: "key",
              message: "ZenMux API Key (sk-payg-… or sk-subs-…)",
              validate: (v) => {
                const s = String(v ?? "").trim();
                if (!s) return "ZenMux requires an API key";
                if (!ANY_KEY_RE.test(s)) return "Expected a ZenMux API key starting with sk-payg-… or sk-subs-…";
                if (MANAGEMENT_KEY_RE.test(s)) return "Enter your inference key (sk-payg- or sk-subs-) here; the Management key goes in the next field";
                return undefined;
              },
            },
            {
              type: "password",
              key: "managementKey",
              required: false,
              message: "Management API Key (zenmux.ai/platform/management → sk-mgmt-…; optional, for PAYG balance & Builder Flows)",
              validate: (v) => {
                const s = String(v ?? "").trim();
                if (!s) return undefined;
                if (!MANAGEMENT_KEY_RE.test(s)) return "A ZenMux Management API key starts with sk-mgmt-";
                return undefined;
              },
            },
            {
              type: "text",
              key: "email",
              required: false,
              message: "Account label / Email (optional; names this account in Magpie)",
            },
          ],
          async authorize(inputs, { signal } = {}) {
            const key = String(inputs?.key ?? "").trim();
            const managementKey = String(inputs?.managementKey ?? "").trim();
            const email = String(inputs?.email ?? "").trim();
            if (!key) return { type: "failed", error: "ZenMux requires an API key" };
            if (!ANY_KEY_RE.test(key)) return { type: "failed", error: "Expected a ZenMux API key (sk-payg-… or sk-subs-…)" };
            if (MANAGEMENT_KEY_RE.test(key)) {
              return { type: "failed", error: "Use a Pay-As-You-Go or Subscription inference key here; the Management API key goes in the second field" };
            }
            if (managementKey && !MANAGEMENT_KEY_RE.test(managementKey)) {
              return { type: "failed", error: "A ZenMux Management API key starts with sk-mgmt-" };
            }

            const verdict = await verifyApiKey(key, { signal });
            if (!verdict.ok) {
              const legacy = LEGACY_KEY_RE.test(key)
                ? " — legacy sk-ss-v1- / sk-ai-v1- keys were retired on 2026-11-10; generate a new key"
                : "";
              return {
                type: "failed",
                error: `ZenMux refused this API key${verdict.status ? ` (HTTP ${verdict.status})` : ""}: ${verdict.message}${legacy}`,
              };
            }

            const plan = isPaygKey(key) ? "payg" : isSubscriptionKey(key) ? "builder" : undefined;
            return {
              type: "success",
              key,
              metadata: {
                key: undefined,
                ...(managementKey ? { managementKey } : {}),
                ...(email ? { email } : {}),
                ...(plan ? { plan } : {}),
              },
            };
          },
        },
        {
          type: "oauth",
          label: "ZenMux OAuth (browser sign-in)",
          prompts: [
            {
              type: "password",
              key: "managementKey",
              required: false,
              message: "Management API Key (sk-mgmt-…; optional, for PAYG balance & Builder Flows)",
              validate: (v) => {
                const s = String(v ?? "").trim();
                if (!s) return undefined;
                if (!MANAGEMENT_KEY_RE.test(s)) return "A ZenMux Management API key starts with sk-mgmt-";
                return undefined;
              },
            },
            {
              type: "text",
              key: "email",
              required: false,
              message: "Account label / Email (optional; names this account in Magpie)",
            },
          ],
          async authorize(inputs, { signal } = {}) {
            const managementKey = String(inputs?.managementKey ?? "").trim();
            const email = String(inputs?.email ?? "").trim();
            if (managementKey && !MANAGEMENT_KEY_RE.test(managementKey)) {
              return { type: "failed", error: "A ZenMux Management API key starts with sk-mgmt-" };
            }
            let flow;
            try {
              flow = await beginAuthorization({ origin: oauthOrigin, clientId: oauthClientId, fetchImpl, signal });
            } catch (err) {
              return { type: "failed", error: `Could not start ZenMux OAuth: ${err?.message || "unknown error"}` };
            }
            return {
              url: flow.url,
              instructions: "Complete ZenMux sign-in in your browser.",
              method: "auto",
              async callback() {
                try {
                  const tokens = await flow.complete();
                  return {
                    type: "success",
                    ...tokens,
                    ...(managementKey ? { managementKey } : {}),
                    ...(email ? { email } : {}),
                  };
                } catch (err) {
                  return { type: "failed", error: err?.message || "ZenMux OAuth sign-in failed" };
                }
              },
            };
          },
        },
      ],

      async refresh(auth, { signal } = {}) {
        return refreshAccessToken(auth, { origin: oauthOrigin, clientId: oauthClientId, fetchImpl, signal });
      },

      async usage(getAuth, _provider, { signal } = {}) {
        signal?.throwIfAborted();
        const auth = typeof getAuth === "function" ? await getAuth() : undefined;
        return fetchAccountUsage(auth, {
          managementBase,
          options: userOptions,
          fetchImpl,
          signal,
        });
      },

      async loader(getAuth) {
        const auth = typeof getAuth === "function" ? await getAuth() : undefined;
        let token = bearerOf(auth);
        if (isOAuth(auth) && auth.refresh && Number(auth.expires) > 0 && Number(auth.expires) - Date.now() < 5 * 60 * 1000) {
          const renewed = await refreshAccessToken(auth, { origin: oauthOrigin, clientId: oauthClientId, fetchImpl });
          if (renewed?.access) {
            token = renewed.access;
            await input?.client?.auth?.set?.({
              path: { id: PROVIDER_ID },
              body: { ...auth, ...renewed, type: "oauth" },
            });
          }
        }
        if (!token) return {};

        return {
          apiKey: token,
          async fetch(inputUrl, init) {
            return handlePluginFetch(token, inputUrl, init);
          },
        };
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth, signal } = {}) {
        signal?.throwIfAborted();
        const base = isObj(provider?.models) && Object.keys(provider.models).length
          ? provider.models
          : DEFAULT_FALLBACK_MODELS;
        const token = bearerOf(auth);

        let catalog;
        try {
          catalog = await catalogManager.getCatalog({ token, signal });
        } catch (err) {
          signal?.throwIfAborted();
          if (err?.status === 401 || err?.status === 403) {
            throw Object.assign(new Error(`ZenMux refused this account's API key (HTTP ${err.status}); sign in again`), {
              signIn: "expired",
            });
          }
          const fallback = { ...base };
          fallback[Symbol.for("magpie.fellBack")] = true;
          return fallback;
        }

        const opts = currentOptions();
        const kind = billingKindOf(auth, opts);
        const subscription = kind === "builder" || (kind === "auto" && isOAuth(auth) && !isPaygKey(token));
        const protoOpt = (() => {
          const raw = typeof opts.protocol === "string" ? opts.protocol.trim().toLowerCase() : protocolOption;
          return ["chat", "responses", "messages", "gemini", "auto"].includes(raw) ? raw : "auto";
        })();

        let planFilter = null;
        if (opts.allModels !== true && !allModels && subscription) {
          const tier = await resolveBuilderPlanTier(auth, { signal });
          if (tier) {
            try {
              const sets = await catalogManager.getPlanSets({ signal });
              planFilter = sets.get(tier) ?? null;
            } catch {
              planFilter = null;
            }
          }
        }

        const devModels = readModelsDevSnapshot();
        const out = {};
        for (const record of catalog.values()) {
          if (!isModelAllowed(record, opts)) continue;
          if (planFilter && record.kind === "chat" && !planFilter.has(record.id)) continue;
          out[record.id] = toMagpieModel(record, base[record.id], {
            subscription,
            protocolOption: protoOpt,
            chatApi: apiBase,
            anthropicApi: anthropicBase,
            vertexApi: vertexBase,
            dev: devModels[record.id],
          });
        }
        return out;
      },
    },
  };
}

export default ZenMuxPlugin;

export const _internal = {
  CURATED_CHAT_MODELS,
  CURATED_IMAGE_MODELS,
  CURATED_VIDEO_MODELS,
  LEGACY_IMAGE_MODELS,
  LEGACY_VIDEO_MODELS,
  classifyModel,
  normalizeCatalogEntries,
  planModelSets,
  resolveImageProtocol,
  resolveTextProtocols,
  resolveVideoProtocol,
  sortCatalogRecords,
  toMagpieModel,
  subscriptionToUsage,
  paygToUsage,
};
