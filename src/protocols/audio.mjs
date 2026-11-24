import { API_BASE_URL, isObj, problem } from "../constants.mjs";

const OPENAI_TO_GEMINI_VOICE = new Map([
  ["alloy", "Kore"],
  ["ash", "Charon"],
  ["ballad", "Algieba"],
  ["coral", "Sulafat"],
  ["echo", "Iapetus"],
  ["fable", "Puck"],
  ["onyx", "Algenib"],
  ["nova", "Zephyr"],
  ["sage", "Vindemiatrix"],
  ["shimmer", "Achernar"],
  ["verse", "Rasalgethi"],
  ["marin", "Aoede"],
  ["cedar", "Schedar"],
]);

const GEMINI_VOICES = new Map(
  [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
  ].map((v) => [v.toLowerCase(), v]),
);

export function normalizeTtsVoice(model, voice) {
  const id = String(model ?? "").toLowerCase();
  const raw = typeof voice === "string" ? voice.trim() : "";
  const lower = raw.toLowerCase();

  if (id.startsWith("google/gemini-")) {
    if (GEMINI_VOICES.has(lower)) return GEMINI_VOICES.get(lower);
    if (OPENAI_TO_GEMINI_VOICE.has(lower)) return OPENAI_TO_GEMINI_VOICE.get(lower);
    return "Kore";
  }

  // Qwen and Grok TTS reject OpenAI placeholder voice names like "alloy" with 404.
  if (OPENAI_TO_GEMINI_VOICE.has(lower)) {
    return undefined;
  }
  return raw || undefined;
}

export function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export async function handleSpeechRequest(req, { token, apiBase = API_BASE_URL, fetchImpl = fetch } = {}) {
  let body;
  try {
    body = await req.json();
  } catch {
    throw problem(400, "Invalid JSON body for /v1/audio/speech");
  }
  if (!isObj(body)) throw problem(400, "Speech request body must be a JSON object");

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const input = typeof body.input === "string" ? body.input : "";
  if (!model) throw problem(400, "Speech synthesis requires a model ID");
  if (!input.trim()) throw problem(400, "Speech synthesis requires non-empty input text");

  const requestedFormat = typeof body.response_format === "string" ? body.response_format.trim().toLowerCase() : "";
  const voice = normalizeTtsVoice(model, body.voice);
  const payload = { ...body };
  if (voice) payload.voice = voice;
  else delete payload.voice;

  const res = await fetchImpl(`${apiBase}/audio/speech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, audio/*",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) return res;

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return res;
  }

  // ZenMux /api/v1/audio/speech wraps audio in JSON: { audio: "<base64>", mime_type: "audio/mpeg" | "audio/wav" | "audio/pcm" }
  const data = await res.json();
  const b64 = data?.audio ?? data?.audio_data ?? data?.data;
  if (typeof b64 !== "string" || !b64) {
    throw problem(502, "ZenMux TTS response did not contain audio data");
  }
  let audioBytes = Buffer.from(b64, "base64");
  let mimeType = typeof data?.mime_type === "string" && data.mime_type ? data.mime_type : "audio/mpeg";

  // Wrap raw 24kHz PCM in a WAV header unless the caller specifically requested raw pcm.
  if ((mimeType.includes("pcm") || mimeType.includes("l16")) && requestedFormat !== "pcm") {
    audioBytes = pcmToWav(audioBytes, 24000);
    mimeType = "audio/wav";
  }

  return new Response(audioBytes, {
    status: 200,
    headers: {
      "content-type": mimeType,
      "content-length": String(audioBytes.length),
    },
  });
}

function detectAudioFormat(fileName = "", mimeType = "") {
  const ext = String(fileName).split(".").pop()?.toLowerCase() || "";
  const mime = String(mimeType).toLowerCase();
  if (ext === "mp3" || ext === "mpeg" || ext === "mpga" || mime.includes("mpeg") || mime.includes("mp3")) return { format: "mp3", mimeType: "audio/mp3" };
  if (ext === "wav" || ext === "wave" || mime.includes("wav")) return { format: "wav", mimeType: "audio/wav" };
  if (ext === "ogg" || ext === "oga" || ext === "opus" || mime.includes("ogg") || mime.includes("opus")) return { format: "ogg", mimeType: "audio/ogg" };
  if (ext === "flac" || mime.includes("flac")) return { format: "flac", mimeType: "audio/flac" };
  if (ext === "m4a" || ext === "mp4" || mime.includes("mp4") || mime.includes("m4a")) return { format: "m4a", mimeType: "audio/m4a" };
  if (ext === "webm" || mime.includes("webm")) return { format: "webm", mimeType: "audio/webm" };
  return { format: "wav", mimeType: "audio/wav" };
}

export async function parseTranscriptionRequest(req) {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    const model = String(form.get("model") ?? "").trim();
    const language = form.get("language") ? String(form.get("language")).trim() : undefined;
    const prompt = form.get("prompt") ? String(form.get("prompt")).trim() : undefined;
    const responseFormat = form.get("response_format") ? String(form.get("response_format")).trim().toLowerCase() : "json";
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      throw problem(400, "Audio transcription requires a file part in multipart/form-data");
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.length) throw problem(400, "Uploaded audio file is empty");
    const { format, mimeType } = detectAudioFormat(file.name, file.type);
    return {
      model,
      base64Data: buf.toString("base64"),
      format,
      mimeType,
      language,
      prompt,
      responseFormat,
    };
  }

  let body;
  try {
    body = await req.json();
  } catch {
    throw problem(400, "Audio transcription requires multipart/form-data or JSON");
  }
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const language = typeof body?.language === "string" ? body.language.trim() : undefined;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : undefined;
  const responseFormat = typeof body?.response_format === "string" ? body.response_format.trim().toLowerCase() : "json";

  let rawData = "";
  let format = "wav";
  if (typeof body?.input_audio === "string") {
    rawData = body.input_audio;
  } else if (isObj(body?.input_audio)) {
    rawData = body.input_audio.data || body.input_audio.url || "";
    if (typeof body.input_audio.format === "string" && body.input_audio.format) {
      format = body.input_audio.format.toLowerCase();
    }
  }
  const dataUrlMatch = /^data:(audio\/[a-z0-9.+-]+);base64,(.+)$/i.exec(rawData);
  const base64Data = dataUrlMatch ? dataUrlMatch[2] : rawData;
  const detected = detectAudioFormat(`audio.${format}`, dataUrlMatch?.[1] || "");

  return {
    model,
    base64Data,
    format: detected.format,
    mimeType: detected.mimeType,
    language,
    prompt,
    responseFormat,
    rawBody: body,
  };
}

export async function handleTranscriptionRequest(req, { token, apiBase = API_BASE_URL, findModel, fetchImpl = fetch } = {}) {
  const parsed = await parseTranscriptionRequest(req);
  if (!parsed.model) throw problem(400, "Audio transcription requires a model ID");
  if (!parsed.base64Data) throw problem(400, "Audio transcription requires audio data");

  const record = findModel ? await findModel(parsed.model) : null;
  const apis = record?.supported_apis ?? [];
  const usesChat = parsed.model === "qwen/qwen3-asr-flash" || (apis.includes("chat.completions") && !apis.includes("audio.transcriptions"));

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  let transcriptText = "";
  let usage;

  if (usesChat) {
    const content = [
      {
        type: "input_audio",
        input_audio: {
          data: `data:${parsed.mimeType};base64,${parsed.base64Data}`,
          format: parsed.format,
        },
      },
    ];
    if (parsed.prompt) {
      content.push({ type: "text", text: parsed.prompt });
    }
    const res = await fetchImpl(`${apiBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: parsed.model,
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: req.signal,
    });
    if (!res.ok) return res;
    const data = await res.json();
    transcriptText = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
    usage = data?.usage;
  } else {
    const payload = {
      model: parsed.model,
      input_audio: {
        data: parsed.base64Data,
        format: parsed.format,
      },
      ...(parsed.language ? { language: parsed.language } : {}),
    };
    const res = await fetchImpl(`${apiBase}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: req.signal,
    });
    if (!res.ok) return res;
    const data = await res.json();
    transcriptText = typeof data?.text === "string" ? data.text : "";
    usage = data?.usage;
  }

  if (parsed.responseFormat === "text") {
    return new Response(transcriptText, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (parsed.responseFormat === "verbose_json") {
    return Response.json({
      task: "transcribe",
      language: parsed.language || "auto",
      duration: usage?.seconds ?? 0,
      text: transcriptText,
      segments: [],
      ...(usage ? { usage } : {}),
    });
  }
  return Response.json({
    text: transcriptText,
    model: parsed.model,
    ...(usage ? { usage } : {}),
  });
}
