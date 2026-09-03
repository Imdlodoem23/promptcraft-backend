// PromptCraft backend — turns a natural-language building request into a strict
// JSON action plan that the Roblox game executes. "GPT Luna 5.6" is the in-game
// brand name. By default it calls OpenAI's `gpt-5.6-luna` directly with
// OPENAI_API_KEY. Set AI_GATEWAY_API_KEY instead to route through the Vercel AI
// Gateway (then use REAL_MODEL like "openai/gpt-5.6-luna-fast").
//
// Run:  OPENAI_API_KEY=... SHARED_SECRET=... node server.js
// Endpoint:  POST /interpret   (header x-shared-secret must match SHARED_SECRET)

import http from "node:http";
import crypto from "node:crypto";
import OpenAI from "openai";

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || "change-me";
const REAL_MODEL = process.env.REAL_MODEL || "gpt-5.6-luna";
const MODEL_ALIAS = process.env.MODEL_ALIAS || "gpt-luna-5.6";

const GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const EXPLICIT_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_GATEWAY_BASE_URL || "";

// ---- reference image (preview) config ----
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "openai").toLowerCase(); // openai | flux | none
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";
const FLUX_API_KEY = process.env.FLUX_API_KEY || "";
const FLUX_PROVIDER = (process.env.FLUX_PROVIDER || "bfl").toLowerCase(); // bfl | replicate | fal
const FLUX_MODEL = process.env.FLUX_MODEL || ""; // replicate: version id | fal: "fal-ai/flux/dev" | bfl: "flux-dev"
const PREVIEW_ENABLED = (process.env.PREVIEW_ENABLED ?? "1") !== "0";
const ROBLOX_OPEN_CLOUD_KEY = process.env.ROBLOX_OPEN_CLOUD_KEY || "";
const ROBLOX_CREATOR_ID = process.env.ROBLOX_CREATOR_ID || "";
const ROBLOX_CREATOR_TYPE = (process.env.ROBLOX_CREATOR_TYPE || "User").toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// images always go to OpenAI's own endpoint (the gateway may not proxy images)
const imageClientOpenAI = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// token -> { actions, ts } for the preview -> confirm handshake
const pending = new Map();
function stashPlan(actions) {
  const token = crypto.randomUUID();
  pending.set(token, { actions, ts: Date.now() });
  return token;
}
function takePlan(token) {
  const rec = token && pending.get(token);
  if (token) pending.delete(token);
  if (!rec || Date.now() - rec.ts > 600000) return null;
  return rec.actions;
}

// ---- image generation (returns a PNG Buffer or null) ----
async function generateImage(prompt) {
  const p = "Isometric low-poly Roblox-style 3D render, 3/4 top-down view, clean solid colors, no text: " + prompt;
  if (IMAGE_PROVIDER === "openai") {
    if (!imageClientOpenAI) return null;
    const r = await imageClientOpenAI.images.generate({ model: IMAGE_MODEL, prompt: p, size: "1024x1024", n: 1 });
    const b64 = r.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, "base64");
    const url = r.data?.[0]?.url;
    if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
    return null;
  }
  if (IMAGE_PROVIDER === "flux") {
    if (!FLUX_API_KEY) return null;

    if (FLUX_PROVIDER === "fal") {
      // cheapest: FLUX.1 [schnell] ~ $0.003 / image
      const model = FLUX_MODEL || "fal-ai/flux/schnell";
      const r = await fetch("https://fal.run/" + model, {
        method: "POST",
        headers: { Authorization: "Key " + FLUX_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p, image_size: "square_hd", num_inference_steps: 4 }),
      }).then((x) => x.json());
      const url = r.images?.[0]?.url;
      if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
      return null;
    }

    if (FLUX_PROVIDER === "replicate") {
      // cheapest: black-forest-labs/flux-schnell ~ $0.003 / image
      const isVersion = /^[0-9a-f]{40,}$/.test(FLUX_MODEL);
      const endpoint = isVersion
        ? "https://api.replicate.com/v1/predictions"
        : "https://api.replicate.com/v1/models/" + (FLUX_MODEL || "black-forest-labs/flux-schnell") + "/predictions";
      const body = isVersion ? { version: FLUX_MODEL, input: { prompt: p } } : { input: { prompt: p } };
      const pred = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + FLUX_API_KEY, "Content-Type": "application/json", Prefer: "wait" },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      let out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      // if it didn't finish within Prefer:wait, poll
      for (let i = 0; i < 20 && !out && pred?.urls?.get; i++) {
        await sleep(1500);
        const s = await fetch(pred.urls.get, { headers: { Authorization: "Bearer " + FLUX_API_KEY } }).then((x) => x.json());
        if (s.status === "succeeded") out = Array.isArray(s.output) ? s.output[0] : s.output;
        if (s.status === "failed" || s.status === "canceled") break;
      }
      if (out) return Buffer.from(await (await fetch(out)).arrayBuffer());
      return null;
    }

    if (FLUX_PROVIDER === "bfl") {
      // BFL has no schnell; flux-dev is its cheapest
      const model = FLUX_MODEL || "flux-dev";
      const start = await fetch("https://api.bfl.ai/v1/" + model, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": FLUX_API_KEY },
        body: JSON.stringify({ prompt: p, width: 1024, height: 1024 }),
      }).then((x) => x.json());
      const pollUrl = start.polling_url;
      for (let i = 0; i < 30 && pollUrl; i++) {
        await sleep(1500);
        const s = await fetch(pollUrl, { headers: { "x-key": FLUX_API_KEY } }).then((x) => x.json());
        if (s.status === "Ready" && s.result?.sample) {
          return Buffer.from(await (await fetch(s.result.sample)).arrayBuffer());
        }
        if (s.status && s.status !== "Pending" && s.status !== "Processing") break;
      }
      return null;
    }
  }
  return null;
}

// ---- upload a PNG to Roblox as a Decal via Open Cloud, return { assetId, moderation } ----
async function uploadToRoblox(png, name) {
  if (!ROBLOX_OPEN_CLOUD_KEY || !ROBLOX_CREATOR_ID) return null;
  const creator = ROBLOX_CREATOR_TYPE === "group"
    ? { groupId: Number(ROBLOX_CREATOR_ID) }
    : { userId: Number(ROBLOX_CREATOR_ID) };
  const form = new FormData();
  form.append("request", JSON.stringify({
    assetType: "Decal",
    displayName: ("PC " + name).slice(0, 50),
    description: "PromptCraft reference image",
    creationContext: { creator },
  }));
  form.append("fileContent", new Blob([png], { type: "image/png" }), "ref.png");

  const up = await fetch("https://apis.roblox.com/assets/v1/assets", {
    method: "POST",
    headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY },
    body: form,
  });
  const j = await up.json().catch(() => ({}));
  if (!up.ok) {
    console.error("roblox upload failed:", up.status, JSON.stringify(j).slice(0, 300));
    return null;
  }
  let opId = j.operationId || (typeof j.path === "string" ? j.path.split("/").pop() : null);
  if (j.done && j.response?.assetId) {
    return { assetId: String(j.response.assetId), moderation: j.response?.moderationResult?.moderationState || "Unknown" };
  }
  for (let i = 0; i < 25 && opId; i++) {
    await sleep(1500);
    const o = await fetch("https://apis.roblox.com/assets/v1/operations/" + opId, {
      headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY },
    }).then((x) => x.json()).catch(() => ({}));
    if (o.done) {
      const assetId = o.response?.assetId;
      if (assetId) return { assetId: String(assetId), moderation: o.response?.moderationResult?.moderationState || "Unknown" };
      return null;
    }
  }
  return null;
}

async function makePreview(promptText, actions) {
  if (!PREVIEW_ENABLED || IMAGE_PROVIDER === "none") return null;
  if (!ROBLOX_OPEN_CLOUD_KEY || !ROBLOX_CREATOR_ID) return null;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  try {
    const png = await generateImage(String(promptText || "").slice(0, 300));
    if (!png) return null;
    const uploaded = await uploadToRoblox(png, String(promptText || "").slice(0, 30));
    if (!uploaded?.assetId) return null;
    return { assetId: uploaded.assetId, moderation: uploaded.moderation, token: stashPlan(actions) };
  } catch (e) {
    console.error("preview error:", e?.message || e);
    return null;
  }
}

const HARD_RULES = [
  "You are the build planner for a Roblox sandbox game.",
  "Return ONLY a JSON object: {\"reply\": string, \"actions\": array}.",
  "reply is one short friendly sentence in the SAME LANGUAGE as the user.",
  "Action types: spawn, obby, modify_last, undo, clear.",
  "spawn.shape: cube|sphere|cylinder|wedge|floor|wall|pillar|tower|platform|kill|checkpoint|ramp",
  "  plus MACRO shapes that expand into many parts: house|bridge|stairs|tree|fence|arch|dome|pyramid.",
  "spawn fields: count (1-40), color, material, scale (usually 0.5-3), position.rel (front|back|left|right|up|center).",
  "shape 'kill' kills on touch. 'checkpoint' is a respawn flag. 'platform' is a small step.",
  "obby: {\"type\":\"obby\",\"stages\":2-10} = a FULL multi-stage jump course. For any obby/parkour/jump-course request use ONE obby action, never walls/towers.",
  "tycoon: {\"type\":\"tycoon\"} = a FULL working starter tycoon (dropper, conveyor, green SELL pad = Cash, upgrade pads).",
  "simulator: {\"type\":\"simulator\",\"orbs\":20} = a FULL simulator base (spawn pad, shop, rebirth, collectible orbs = Coins).",
  "For a tycoon/factory/money game use ONE tycoon action; for a collect/grind/simulator game use ONE simulator action.",
  "modify_last fields: color, material, scale.",
  "Keep actions minimal (1-4). If unclear, return actions:[] and ask a short question. No prose outside the JSON.",
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
    return send(res, 200, {
      ok: true, model: MODEL_ALIAS, backing: REAL_MODEL, keySet: !!client,
      preview: PREVIEW_ENABLED && IMAGE_PROVIDER !== "none" && !!ROBLOX_OPEN_CLOUD_KEY && !!ROBLOX_CREATOR_ID,
      imageProvider: IMAGE_PROVIDER,
    });
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
    const phase = payload.phase || "plan";
    try {
      // phase 2: the player pressed OK -> return the stashed plan, no LLM call
      if (phase === "confirm") {
        const actions = takePlan(payload.token);
        if (!actions) {
          return send(res, 200, { reply: "El plan caducó, pídelo otra vez.", actions: [], tokens: 0 });
        }
        return send(res, 200, { reply: "¡Generando!", actions, tokens: 0 });
      }

      // plan the actions with the LLM
      const result = await interpret(payload);

      // phase 1: try to produce a reference image + hold the plan for confirmation
      if (phase === "preview" && Array.isArray(result.actions) && result.actions.length > 0) {
        const preview = await makePreview(payload.prompt, result.actions);
        if (preview) {
          return send(res, 200, {
            reply: result.reply,
            tokens: result.tokens,
            preview: { assetId: preview.assetId, moderation: preview.moderation },
            token: preview.token,
          });
        }
      }

      // no preview available -> just return the plan to build now
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
