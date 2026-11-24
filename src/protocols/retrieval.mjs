import { API_BASE_URL, isObj, problem } from "../constants.mjs";

export function normalizeRerankBody(body) {
  if (!isObj(body)) throw problem(400, "Rerank request body must be a JSON object");
  if (isObj(body.input)) return body;

  const { model, query, documents, top_n, topN, return_documents, returnDocuments, ...rest } = body;
  const q = typeof query === "string" ? query : "";
  const docs = Array.isArray(documents)
    ? documents.map((d) => (typeof d === "string" ? d : typeof d?.text === "string" ? d.text : String(d ?? "")))
    : [];
  const parameters = { ...(isObj(rest.parameters) ? rest.parameters : {}) };
  const n = top_n ?? topN;
  if (n !== undefined) parameters.top_n = Number(n);
  const retDocs = return_documents ?? returnDocuments;
  if (retDocs !== undefined) parameters.return_documents = Boolean(retDocs);

  return {
    model,
    input: {
      query: q,
      documents: docs,
    },
    ...(Object.keys(parameters).length ? { parameters } : {}),
  };
}

export function systemOneToDecisionsBody(body) {
  const { model, state, questions } = body;
  if (!isObj(questions)) throw problem(400, "System One request requires a questions object");

  const input = typeof state === "string" ? state : JSON.stringify(state ?? "");
  const list = [];
  for (const [name, q] of Object.entries(questions)) {
    if (!isObj(q)) continue;
    const type = q.type === "noul" || q.type === "boolean" ? "predicate" : q.type;
    const item = {
      name,
      type,
      instructions: typeof q.instructions === "string" ? q.instructions : "",
    };
    if (type === "choice" && isObj(q.criteria)) {
      item.choices = Object.entries(q.criteria).map(([value, description]) => ({
        value,
        ...(typeof description === "string" ? { description } : {}),
      }));
    } else if (type === "score" && Array.isArray(q.criteria)) {
      item.levels = q.criteria.map((c) => {
        const [label, ...desc] = String(c).split(":");
        return { label: label.trim(), description: desc.join(":").trim() };
      });
    }
    list.push(item);
  }
  return { model, input, questions: list };
}

export function decisionsToSystemOneResponse(payload, requestedQuestions = {}) {
  const answers = {};
  for (const ans of Array.isArray(payload?.answers) ? payload.answers : []) {
    if (!isObj(ans) || typeof ans.name !== "string") continue;
    const orig = requestedQuestions[ans.name];
    if (ans.type === "predicate" || orig?.type === "noul") {
      answers[ans.name] = { type: "noul", noul: ans.probability ?? ans.noul ?? 0 };
    } else if (ans.type === "choice") {
      answers[ans.name] = { type: "choice", choice: ans.choice, ...(ans.probabilities ? { distribution: ans.probabilities } : {}) };
    } else if (ans.type === "score") {
      answers[ans.name] = { type: "score", score: ans.score, ...(ans.level ? { level: ans.level } : {}) };
    } else {
      answers[ans.name] = ans;
    }
  }
  return {
    model: payload?.model,
    answers,
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}

export async function handleRerankRequest(req, { token, apiBase = API_BASE_URL, fetchImpl = fetch } = {}) {
  let body;
  try {
    body = await req.json();
  } catch {
    throw problem(400, "Invalid JSON body for /v1/rerank");
  }
  const payload = normalizeRerankBody(body);
  return fetchImpl(`${apiBase}/rerank`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });
}

export async function handleSystemOneRequest(req, { token, apiBase = API_BASE_URL, findModel, fetchImpl = fetch } = {}) {
  let body;
  try {
    body = await req.json();
  } catch {
    throw problem(400, "Invalid JSON body for /v1/systemone");
  }
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const record = findModel && model ? await findModel(model) : null;
  const apis = record?.supported_apis ?? [];
  const usesDecisionsApi =
    model.startsWith("cloudflare/clef") ||
    model === "openai/gpt-6-luna" ||
    (apis.includes("decisions") && !apis.includes("systemone"));

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  if (usesDecisionsApi && isObj(body?.questions) && !Array.isArray(body.questions)) {
    const converted = systemOneToDecisionsBody(body);
    const res = await fetchImpl(`${apiBase}/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify(converted),
      signal: req.signal,
    });
    if (!res.ok) return res;
    const data = await res.json();
    return Response.json(decisionsToSystemOneResponse(data, body.questions), { status: 200 });
  }

  return fetchImpl(`${apiBase}/systemone`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
}
