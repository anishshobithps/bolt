# Bolt

A general-purpose Discord bot built with [Sapphire](https://sapphirejs.dev/), [discord.js](https://discord.js.org/), and [Bun](https://bun.sh/).

## Features

**AI Mentions** — Mention the bot to chat or search. Uses `perplexity/sonar-pro` for lookups (Wikipedia, news, real-time web) and `google/gemini-2.5-flash` for casual conversation. Per-user history (12 messages, 7-day TTL) stored in Redis. Supports reply context, long-form responses, cited sources, memory reset, and a 5 req/30s rate limit.

**`/aigenick`** — Scans a member's messages, embeds their writing style, and roasts them with an AI-generated nickname (`google/gemma-3-27b-it`). Caches results by embedding similarity. 30s guild cooldown. Requires **Manage Nicknames** to target others.

**Reddit feeds** — Pull subreddit posts into channels on a schedule. Feeds are grouped per channel with configurable rotation (`weighted-random`, `round-robin`, `least-recent`, `strict-priority`), interval, weight, source (`hot`/`new`), NSFW filtering, and optional discussion threads. Requires **Manage Server**.

**Starboard** — Reposts messages that hit a reaction threshold to a designated channel. Requires **Manage Server**.

## Setup

```bash
bun install
```

`.env`:

```env
DISCORD_TOKEN=
GUILD_ID=                     # optional, faster command registration
TURSO_URL=
TURSO_AUTH_TOKEN=
OPENROUTER_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

- **Turso** — `turso db create bolt` then grab the URL and token from `turso db show bolt` / `turso db tokens create bolt`
- **Upstash** — free Redis database; enable **Eviction (`allkeys-lru`)** to avoid write failures on the free tier

```bash
bun run dev      # watch mode
bun run start    # production
```

## Stack

[Bun](https://bun.sh/) · [discord.js](https://discord.js.org/) v14 · [Sapphire](https://sapphirejs.dev/) · [Effect](https://effect.website/) · [Turso](https://turso.tech/) · [Upstash Redis](https://upstash.com/) · [OpenRouter](https://openrouter.ai/)
