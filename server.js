// PromptCraft backend — turns a natural-language building request into a strict
// JSON action plan that the Roblox game executes. "GPT Luna 5.6" is the in-game
// brand name. By default it calls OpenAI's `gpt-5.6-luna` directly with
// OPENAI_API_KEY. Set AI_GATEWAY_API_KEY instead to route through the Vercel AI
// Gateway (then use REAL_MODEL like "openai/gpt-5.6-luna-fast").
//
// Run:  OPENAI_API_KEY=... SHARED_SECRET=... node server.js
// Endpoint:  POST /interpret   (header x-shared-secret must match SHARED_SECRET)

import http from "node:http";
import OpenAI from "openai";

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || "change-me";
const REAL_MODEL = process.env.REAL_MODEL || "gpt-5.6-luna";
const MODEL_ALIAS = process.env.MODEL_ALIAS || "gpt-luna-5.6";

const GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const EXPLICIT_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_GATEWAY_BASE_URL || "";

// Spend guardrail: hard ceiling on real model calls per UTC day across ALL
// players and servers. Over the cap, /interpret returns actions:[] and the game
// silently falls back to its free offline parser. Counter is in-memory, so it
// resets on restart/redeploy — treat it as a soft monthly-bill protector, not
// an accountant. Set DAILY_REQUEST_CAP=0 to disable.
const DAILY_REQUEST_CAP = Number(process.env.DAILY_REQUEST_CAP ?? 3000);
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function overDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  return DAILY_REQUEST_CAP > 0 && dayCount >= DAILY_REQUEST_CAP;
}

// Boot-safe: with no key the service still starts green; the game uses its
// offline parser until you add OPENAI_API_KEY (or AI_GATEWAY_API_KEY) in Render.
let client = null;
if (GATEWAY_KEY) {
  client = new OpenAI({
    apiKey: GATEWAY_KEY,
    baseURL: EXPLICIT_BASE_URL || "https://ai-gateway.vercel.sh/v1",
  });
} else if (OPENAI_KEY) {
  client = EXPLICIT_BASE_URL
    ? new OpenAI({ apiKey: OPENAI_KEY, baseURL: EXPLICIT_BASE_URL })
    : new OpenAI({ apiKey: OPENAI_KEY }); // OpenAI's own endpoint
}

const HARD_RULES = [
  "You are the build planner for a Roblox sandbox game.",
  "Return ONLY a JSON object of the form:",
  '{"reply": string, "actions": array}.',
  "reply is one short friendly sentence in the SAME LANGUAGE as the user.",
  "Allowed action types: spawn, modify_last, undo, clear.",
  "spawn fields: shape (cube|sphere|cylinder|wedge|floor|wall|pillar|tower),",
  "count (1-40), color (name or #hex), material",
  "(plastic|wood|metal|neon|glass|brick|grass|sand|ice|concrete|marble|slate),",
  "scale (0.2-6), position.rel (front|back|left|right|up|center).",
  "modify_last fields: color, material, scale.",
  "Keep actions minimal. If the request is unclear, return actions:[] and ask a",
  "short clarifying question in reply. Never include prose outside the JSON.",
].join(" ");

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function interpret(payload) {
  if (!client) {
    return {
      reply: "GPT Luna 5.6 aún no tiene su clave configurada. Modo básico por ahora.",
      actions: [],
      tokens: 0,
    };
  }
  if (overDailyCap()) {
    return {
      reply: "GPT Luna 5.6 alcanzó su límite diario. Sigues construyendo en modo básico.",
      actions: [],
      tokens: 0,
    };
  }
  dayCount++;

  const userText = String(payload.prompt || "").slice(0, 3200);
  const ctx = payload.context ? JSON.stringify(payload.context).slice(0, 2000) : "{}";
  let extraSystem = typeof payload.system === "string" ? payload.system.slice(0, 4000) : "";

  const gameType = payload.context && typeof payload.context.gameType === "string" ? payload.context.gameType : null;
  if (gameType) {
    const hint = {
      tycoon: "The player is building a TYCOON: bias toward droppers, conveyors, sell pads, buy buttons, and a growing factory floor.",
      simulator: "The player is building a SIMULATOR: bias toward collectible orbs, spawn pads, upgrade shops, and open areas to run around.",
      custom: "The player is building a CUSTOM game: no theme, just build exactly what they ask.",
    }[gameType];
    if (hint) extraSystem = (extraSystem ? extraSystem + "\n\n" : "") + hint;
  }

  const messages = [
    { role: "system", content: HARD_RULES + (extraSystem ? "\n\n" + extraSystem : "") },
    {
      role: "user",
      content: `Player context (JSON): ${ctx}\n\nPlayer request (respond with JSON): ${userText}`,
    },
  ];

  // gpt-5.6-luna is a reasoning model: it wants max_completion_tokens (not
  // max_tokens), rejects temperature != 1, and burns tokens on reasoning — so
  // give it room and keep effort low for latency. Older/cheaper models use the
  // classic shape. Try reasoning shape, then fall back.
  let completion;
  try {
    completion = await client.chat.completions.create({
      model: REAL_MODEL,
      messages,
      max_completion_tokens: 4000,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
    });
  } catch (e1) {
    try {
      completion = await client.chat.completions.create({
        model: REAL_MODEL,
        messages,
        max_completion_tokens: 4000,
        response_format: { type: "json_object" },
      });
    } catch (e2) {
      completion = await client.chat.completions.create({
        model: REAL_MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.4,
        response_format: { type: "json_object" },
      });
    }
  }

  const usage = completion.usage || {};
  const tokens =
    Number(usage.total_tokens) ||
    (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) ||
    0;

  const choice = completion.choices?.[0];
  if (choice?.finish_reason === "content_filter") {
    return { reply: "GPT Luna 5.6 no puede construir eso. Prueba con otra cosa.", actions: [], tokens };
  }

  const text = choice?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { reply: "No entendí la respuesta. Intenta de nuevo.", actions: [] };
  }

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "Listo.",
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    tokens,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, { ok: true, model: MODEL_ALIAS, backing: REAL_MODEL, keySet: !!client });
  }
  if (req.method === "GET" && req.url === "/stats") {
    if ((req.headers["x-shared-secret"] || "") !== SHARED_SECRET) {
      return send(res, 401, { error: "bad secret" });
    }
    return send(res, 200, {
      day: dayKey,
      requestsToday: dayCount,
      dailyCap: DAILY_REQUEST_CAP,
      model: REAL_MODEL,
    });
  }
  if (req.method !== "POST" || req.url !== "/interpret") {
    return send(res, 404, { error: "not found" });
  }
  if ((req.headers["x-shared-secret"] || "") !== SHARED_SECRET) {
    return send(res, 401, { error: "bad secret" });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 16000) req.destroy();
  });
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    try {
      const result = await interpret(payload);
      send(res, 200, result);
    } catch (err) {
      console.error("interpret error:", err?.status || "", err?.message || err);
      const status = typeof err?.status === "number" ? err.status : 500;
      send(res, status >= 400 && status < 600 ? status : 502, {
        reply: "GPT Luna 5.6 tuvo un problema. Intenta otra vez.",
        actions: [],
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`PromptCraft backend on :${PORT}  (alias ${MODEL_ALIAS} -> ${REAL_MODEL})`);
});
