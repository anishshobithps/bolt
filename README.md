# Bolt

A general-purpose Discord bot. Reddit feeds and starboard are in now, more will be added over time. Built with [Sapphire](https://sapphirejs.dev/), [discord.js](https://discord.js.org/), and [Bun](https://bun.sh/).

---

## Features

### Reddit Feed System

Bolt pulls posts from subreddits on a schedule and drops them into channels you pick. You control which subreddits go where, how often they post, and how the next one gets chosen.

**Groups** are the core unit. A group ties a name to a channel and holds a pool of subreddit feeds. Each feed has its own interval (minimum 15 minutes), weight, and source (`hot` or `new`). When a group's timer fires, Bolt picks one feed from the pool using the group's rotation algorithm, fetches a post it hasn't seen before, skips crossposts, and posts it.

Links are wrapped in **vxReddit** so embeds render properly on Discord.

**Rotation algorithms**

| Algorithm | Behavior |
|---|---|
| `weighted-random` | Feeds are sampled randomly, weighted by their weight value. Default. |
| `round-robin` | Cycles through feeds alphabetically, one at a time. Ignores weight. |
| `least-recent` | Always picks whichever feed posted least recently. |
| `strict-priority` | Highest-weight feed always wins. Ties broken by least-recent. |

**Comment threads** — Set `comments:true` on a feed and Bolt posts a "Discuss" button with each post. Clicking it opens a thread on that message so conversation stays organized.

**NSFW** — Set `nsfw:true` on a feed. If the channel isn't marked Age-Restricted in Discord, NSFW posts are silently skipped.

**Group commands**

```
/reddit group create  name:<n> channel:#ch [algorithm:<a>]
/reddit group edit    name:<n> channel:#ch [algorithm] [interval] [weight] [source] [comments] [nsfw]
/reddit group delete  name:<n> channel:#ch
/reddit group list    [channel:#ch]
/reddit group lock
```

`group edit` applies every option you pass to every feed in the group at once. Useful for resetting a whole channel's posting pace in one command.

`group lock` locks all Reddit-managed channels so members can only talk inside threads.

**Feed commands**

```
/reddit feed add     group:<n> channel:#ch subreddit:<sub> [options]
/reddit feed edit    group:<n> channel:#ch subreddit:<sub> [options]
/reddit feed remove  group:<n> channel:#ch subreddit:<sub>
/reddit feed list    group:<n> channel:#ch
```

Options: `interval` (min 15, default 45) · `weight` 1–100 (default 1) · `source` hot/new · `comments` bool · `nsfw` bool · `enabled` (edit only)

Requires **Manage Server**.

---

### Starboard

When a message collects enough reactions with the same emoji, Bolt reposts it to a starboard channel as a gold embed. Each message appears at most once, and messages already in the starboard channel are never re-posted.

```
/starboard set       channel:#ch [min-reactions:<n>]
/starboard threshold <n>
/starboard unset
```

- `/starboard set` — pick the destination channel, optionally set the threshold at the same time.
- `/starboard threshold` — change the minimum count without touching the channel.
- `/starboard unset` — turn off the starboard for this server.

The count is checked per emoji. If a message gets 4 different reactions but only 3 of the same one, and your threshold is 5, it won't post. Default threshold is `1`.

Requires **Manage Server**.

---

## Setup

**Requirements:** [Bun](https://bun.sh/) and a Discord bot token with the `bot` and `applications.commands` scopes. Required intents: `Guilds`, `GuildMessages`, `MessageContent`, `GuildMessageReactions`.

```bash
bun install
```

Create a `.env` file:

```env
DISCORD_TOKEN=your_bot_token
GUILD_ID=your_guild_id        # optional, scopes commands to one server for faster registration
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token
```

Bolt uses [Turso](https://turso.tech/) (libSQL) for persistence. Create a database with `turso db create bolt` and grab the URL and auth token from `turso db show bolt` and `turso db tokens create bolt`.

```bash
bun run start     # production
bun run dev       # watch mode
```

---

## Stack

- [Bun](https://bun.sh/) — runtime and package manager
- [discord.js](https://discord.js.org/) v14
- [Sapphire Framework](https://sapphirejs.dev/) — command and listener loading
- [Effect](https://effect.website/) — typed errors and dependency injection for database calls
- [Turso](https://turso.tech/) / [libSQL](https://github.com/libsql/libsql-client-ts) — database

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
