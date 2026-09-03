# PromptCraft backend — "GPT Luna 5.6"

Tiny HTTP service. The Roblox game POSTs a player's message here; this returns a
strict JSON action plan that the game builds. It calls the OpenAI (ChatGPT) API —
model `gpt-4o-mini` by default (change with `REAL_MODEL`); the game only ever
shows the alias **GPT Luna 5.6**.

## Endpoint

`POST /interpret`
Header: `x-shared-secret: <SHARED_SECRET>`
Body: `{ "model": "gpt-luna-5.6", "system": "...", "prompt": "haz 3 cubos rojos", "context": { ... } }`
Reply: `{ "reply": "…", "actions": [ … ] }`

## Run locally

```bash
cd promptcraft-backend
npm install
cp .env.example .env      # then edit .env
node --env-file=.env server.js
# test:
curl -s localhost:8080/interpret \
  -H "x-shared-secret: pon-un-secreto-largo" \
  -H "content-type: application/json" \
  -d '{"prompt":"haz una torre azul de neon"}'
```

To reach it from Roblox Studio while testing locally, expose it with a tunnel
(e.g. `cloudflared tunnel --url http://localhost:8080`) and use that HTTPS URL.

## Deploy (Render, free tier)

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → pick the repo.
3. Build command: `npm install` · Start command: `node server.js`
4. Environment variables: `OPENAI_API_KEY`, `SHARED_SECRET`, `REAL_MODEL` (optional).
5. Deploy. Your endpoint is `https://<name>.onrender.com/interpret`.

Works the same on Railway, Fly.io, Cloudflare Workers (needs a small adapter),
a VPS, etc. Any host that runs Node 18+ and holds the API key as an env var.

## Wire it into the game

In Studio: `ServerScriptService/PromptCraft/ServerConfig`

```lua
BACKEND_URL   = "https://<name>.onrender.com/interpret",
SHARED_SECRET = "pon-un-secreto-largo",   -- same value as the backend
```

Leave `BACKEND_URL = ""` to keep playing fully offline (the built-in keyword
parser handles the common requests).

## Cost / safety notes

You pay for every player's GPT Luna 5.6 usage (one OpenAI key, all traffic).
Guardrails, cheapest first:

- **Per-player session quota** — `Config.LLM_REQUESTS_PER_PLAYER` (default 60) in
  Studio. Past it the player keeps building with the free offline parser.
- **Per-server rate** — `Config.SERVER_LLM_PER_MINUTE` (default 40).
- **Global daily cap** — `DAILY_REQUEST_CAP` env here (default 3000/day). Over it,
  `/interpret` returns no actions and the game falls back offline.
- **Model** — `gpt-4o-mini` is already the cheap tier; a bigger model raises cost.
- Each call is tiny: `max_tokens: 1024`, prompt capped at 400 chars.
- `SHARED_SECRET` stops random callers from spending your tokens. It only lives in
  `ServerScriptService` (never sent to clients). Rotate it if it leaks.
- `GET /stats` with the `x-shared-secret` header shows today's request count.
