import { createClient, type Client } from "@libsql/client";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { RotationAlgorithmSchema, type RotationAlgorithm } from "./reddit-rotation.js";

export class DbError extends Data.TaggedError("DbError")<{
    readonly message: string;
}> { }

export class Db extends Context.Tag("Db")<Db, Client>() { }

export const DbLive = Layer.effect(
    Db,
    Effect.try({
        try: () =>
            createClient({
                url: process.env.TURSO_URL!,
                authToken: process.env.TURSO_AUTH_TOKEN,
            }),
        catch: (err) => new DbError({ message: `Failed to create DB client: ${err}` }),
    })
);

export const initDb = Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise({
        try: () =>
            db.batch(
                [
                    `CREATE TABLE IF NOT EXISTS starboard_config (
            guild_id      TEXT PRIMARY KEY,
            channel_id    TEXT NOT NULL,
            min_reactions INTEGER NOT NULL DEFAULT 1
          )`,
                    `CREATE TABLE IF NOT EXISTS starboard_entries (
            original_message_id  TEXT PRIMARY KEY,
            starboard_message_id TEXT NOT NULL,
            guild_id             TEXT NOT NULL
          )`,
                ],
                "write"
            ),
        catch: (err) => new DbError({ message: `Failed to init schema: ${err}` }),
    });
    yield* Effect.tryPromise({
        try: () => db.execute("ALTER TABLE starboard_config ADD COLUMN min_reactions INTEGER NOT NULL DEFAULT 1"),
        catch: () => new DbError({ message: "" }),
    }).pipe(Effect.ignore);
});

export type StarboardConfig = { channelId: string; minReactions: number };

export const getStarboardConfig = (guildId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT channel_id, min_reactions FROM starboard_config WHERE guild_id = ?",
                    args: [guildId],
                }),
            catch: (err) => new DbError({ message: `Failed to get starboard config: ${err}` }),
        });
        const row = result.rows[0];
        if (!row) return undefined;
        return {
            channelId: row.channel_id as string,
            minReactions: row.min_reactions as number,
        } satisfies StarboardConfig;
    });

export const setStarboardChannel = (guildId: string, channelId: string, minReactions?: number) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `INSERT INTO starboard_config (guild_id, channel_id, min_reactions)
                          VALUES (?, ?, ?)
                          ON CONFLICT(guild_id) DO UPDATE SET
                            channel_id    = excluded.channel_id,
                            min_reactions = COALESCE(?, min_reactions)`,
                    args: [guildId, channelId, minReactions ?? 1, minReactions ?? null],
                }),
            catch: (err) => new DbError({ message: `Failed to set starboard channel: ${err}` }),
        });
    });

export const setStarboardThreshold = (guildId: string, minReactions: number) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "UPDATE starboard_config SET min_reactions = ? WHERE guild_id = ?",
                    args: [minReactions, guildId],
                }),
            catch: (err) => new DbError({ message: `Failed to set starboard threshold: ${err}` }),
        });
    });

export const removeStarboardChannel = (guildId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "DELETE FROM starboard_config WHERE guild_id = ?",
                    args: [guildId],
                }),
            catch: (err) => new DbError({ message: `Failed to remove starboard channel: ${err}` }),
        });
    });

export const getStarboardEntry = (originalMessageId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT starboard_message_id FROM starboard_entries WHERE original_message_id = ?",
                    args: [originalMessageId],
                }),
            catch: (err) => new DbError({ message: `Failed to get starboard entry: ${err}` }),
        });
        return result.rows[0]?.starboard_message_id as string | undefined;
    });

export const isStarboardMessage = (messageId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT 1 FROM starboard_entries WHERE starboard_message_id = ? LIMIT 1",
                    args: [messageId],
                }),
            catch: (err) => new DbError({ message: `Failed to check starboard message: ${err}` }),
        });
        return result.rows.length > 0;
    });

export const saveStarboardEntry = (
    originalMessageId: string,
    starboardMessageId: string,
    guildId: string
) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "INSERT OR IGNORE INTO starboard_entries (original_message_id, starboard_message_id, guild_id) VALUES (?, ?, ?)",
                    args: [originalMessageId, starboardMessageId, guildId],
                }),
            catch: (err) => new DbError({ message: `Failed to save starboard entry: ${err}` }),
        });
    });

export const PostSourceSchema = Schema.Literal("new", "hot");
export type PostSource = Schema.Schema.Type<typeof PostSourceSchema>;

export const RedditGroupSchema = Schema.Struct({
    id: Schema.Number,
    guildId: Schema.String,
    channelId: Schema.String,
    name: Schema.String,
    algorithm: RotationAlgorithmSchema,
});
export type RedditGroup = Schema.Schema.Type<typeof RedditGroupSchema>;

const redditFeedFields = {
    id: Schema.Number,
    groupId: Schema.Number,
    subreddit: Schema.String,
    enabled: Schema.Boolean,
    intervalMins: Schema.Number,
    weight: Schema.Number,
    source: PostSourceSchema,
    fetchComments: Schema.Boolean,
    allowNsfw: Schema.Boolean,
    lastCheckedAt: Schema.Number,
} as const;

export const RedditFeedSchema = Schema.Struct(redditFeedFields);
export type RedditFeed = Schema.Schema.Type<typeof RedditFeedSchema>;

export const RedditFeedWithGroupSchema = Schema.Struct({
    ...redditFeedFields,
    guildId: Schema.String,
    channelId: Schema.String,
    groupName: Schema.String,
    algorithm: RotationAlgorithmSchema,
});
export type RedditFeedWithGroup = Schema.Schema.Type<typeof RedditFeedWithGroupSchema>;

export type AddFeedOptions = {
    intervalMins?: number;
    weight?: number;
    source?: PostSource;
    fetchComments?: boolean;
    allowNsfw?: boolean;
};

export type EditFeedOptions = {
    enabled?: boolean;
    intervalMins?: number;
    weight?: number;
    source?: PostSource;
    fetchComments?: boolean;
    allowNsfw?: boolean;
};

export type BulkFeedOptions = Omit<EditFeedOptions, "enabled">;

const decodeFeed = Schema.decodeUnknownSync(RedditFeedSchema);
const decodeGroup = Schema.decodeUnknownSync(RedditGroupSchema);
const decodeFeedWithGroup = Schema.decodeUnknownSync(RedditFeedWithGroupSchema);

function rowToFeed(row: Record<string, unknown>): RedditFeed {
    return decodeFeed({
        id: row["id"],
        groupId: row["group_id"],
        subreddit: row["subreddit"],
        enabled: (row["enabled"] as number) === 1,
        intervalMins: row["interval_mins"],
        weight: row["weight"],
        source: (row["source"] as string) === "top" ? "hot" : row["source"],
        fetchComments: (row["fetch_comments"] as number) === 1,
        allowNsfw: (row["allow_nsfw"] as number) === 1,
        lastCheckedAt: row["last_checked_at"],
    });
}

function rowToGroup(row: Record<string, unknown>): RedditGroup {
    return decodeGroup({
        id: row["id"],
        guildId: row["guild_id"],
        channelId: row["channel_id"],
        name: row["name"],
        algorithm: (row["algorithm"] as string | null) ?? "weighted-random",
    });
}

function rowToFeedWithGroup(row: Record<string, unknown>): RedditFeedWithGroup {
    return decodeFeedWithGroup({
        id: row["id"],
        groupId: row["group_id"],
        subreddit: row["subreddit"],
        enabled: (row["enabled"] as number) === 1,
        intervalMins: row["interval_mins"],
        weight: row["weight"],
        source: (row["source"] as string) === "top" ? "hot" : row["source"],
        fetchComments: (row["fetch_comments"] as number) === 1,
        allowNsfw: (row["allow_nsfw"] as number) === 1,
        lastCheckedAt: row["last_checked_at"],
        guildId: row["guild_id"],
        channelId: row["channel_id"],
        groupName: row["group_name"],
        algorithm: (row["algorithm"] as string | null) ?? "weighted-random",
    });
}

export const initRedditDb = Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise({
        try: () =>
            db.batch(
                [
                    `CREATE TABLE IF NOT EXISTS reddit_groups (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        guild_id    TEXT NOT NULL,
                        channel_id  TEXT NOT NULL,
                        name        TEXT NOT NULL COLLATE NOCASE,
                        algorithm   TEXT NOT NULL DEFAULT 'weighted-random',
                        UNIQUE(guild_id, channel_id, name)
                    )`,
                    `CREATE TABLE IF NOT EXISTS reddit_feeds (
                        id              INTEGER PRIMARY KEY AUTOINCREMENT,
                        group_id        INTEGER NOT NULL REFERENCES reddit_groups(id) ON DELETE CASCADE,
                        subreddit       TEXT NOT NULL,
                        enabled         INTEGER NOT NULL DEFAULT 1,
                        interval_mins   INTEGER NOT NULL DEFAULT 45,
                        weight          INTEGER NOT NULL DEFAULT 1,
                        source          TEXT NOT NULL DEFAULT 'hot',
                        time_filter     TEXT NOT NULL DEFAULT 'day',
                        fetch_comments  INTEGER NOT NULL DEFAULT 0,
                        allow_nsfw      INTEGER NOT NULL DEFAULT 0,
                        last_checked_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(group_id, subreddit)
                    )`,
                    `CREATE TABLE IF NOT EXISTS reddit_seen (
                        group_id INTEGER NOT NULL,
                        post_id  TEXT    NOT NULL,
                        seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
                        PRIMARY KEY (group_id, post_id)
                    )`,
                    `CREATE INDEX IF NOT EXISTS reddit_seen_group_idx ON reddit_seen(group_id, seen_at DESC)`,
                    `CREATE INDEX IF NOT EXISTS reddit_feeds_group_idx ON reddit_feeds(group_id)`,
                ],
                "write"
            ),
        catch: (err) => new DbError({ message: `Failed to init Reddit schema: ${err}` }),
    });
    yield* Effect.tryPromise({
        try: () => db.execute("ALTER TABLE reddit_feeds ADD COLUMN allow_nsfw INTEGER NOT NULL DEFAULT 0"),
        catch: () => new DbError({ message: "" }),
    }).pipe(Effect.ignore);
    yield* Effect.tryPromise({
        try: () => db.execute("ALTER TABLE reddit_groups ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'weighted-random'"),
        catch: () => new DbError({ message: "" }),
    }).pipe(Effect.ignore);
});

export const createRedditGroup = (guildId: string, channelId: string, name: string, algorithm: RotationAlgorithm = "weighted-random") =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "INSERT INTO reddit_groups (guild_id, channel_id, name, algorithm) VALUES (?, ?, ?, ?)",
                    args: [guildId, channelId, name, algorithm],
                }),
            catch: (err) => new DbError({ message: `Failed to create Reddit group: ${err}` }),
        });
    });

export const setGroupAlgorithm = (guildId: string, channelId: string, name: string, algorithm: RotationAlgorithm) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "UPDATE reddit_groups SET algorithm = ? WHERE guild_id = ? AND channel_id = ? AND name = ? COLLATE NOCASE",
                    args: [algorithm, guildId, channelId, name],
                }),
            catch: (err) => new DbError({ message: `Failed to set group algorithm: ${err}` }),
        });
        return (result.rowsAffected ?? 0) > 0;
    });

export const deleteRedditGroup = (guildId: string, channelId: string, name: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "DELETE FROM reddit_groups WHERE guild_id = ? AND channel_id = ? AND name = ?",
                    args: [guildId, channelId, name],
                }),
            catch: (err) => new DbError({ message: `Failed to delete Reddit group: ${err}` }),
        });
        return (result.rowsAffected ?? 0) > 0;
    });

export const getRedditGroup = (guildId: string, channelId: string, name: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT id, guild_id, channel_id, name, algorithm FROM reddit_groups WHERE guild_id = ? AND channel_id = ? AND name = ? COLLATE NOCASE",
                    args: [guildId, channelId, name],
                }),
            catch: (err) => new DbError({ message: `Failed to get Reddit group: ${err}` }),
        });
        const row = result.rows[0];
        if (!row) return undefined;
        return rowToGroup(row as Record<string, unknown>);
    });

export const listRedditGroups = (guildId: string, channelId?: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                channelId
                    ? db.execute({
                        sql: "SELECT id, guild_id, channel_id, name, algorithm FROM reddit_groups WHERE guild_id = ? AND channel_id = ? ORDER BY name COLLATE NOCASE",
                        args: [guildId, channelId],
                    })
                    : db.execute({
                        sql: "SELECT id, guild_id, channel_id, name, algorithm FROM reddit_groups WHERE guild_id = ? ORDER BY channel_id, name COLLATE NOCASE",
                        args: [guildId],
                    }),
            catch: (err) => new DbError({ message: `Failed to list Reddit groups: ${err}` }),
        });
        return result.rows.map((row) => rowToGroup(row as Record<string, unknown>));
    });

export const addRedditFeed = (groupId: number, subreddit: string, opts: AddFeedOptions = {}) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `INSERT INTO reddit_feeds
                          (group_id, subreddit, interval_mins, weight, source, fetch_comments, allow_nsfw)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        groupId,
                        subreddit.toLowerCase(),
                        opts.intervalMins ?? 45,
                        opts.weight ?? 1,
                        opts.source ?? "hot",
                        opts.fetchComments ? 1 : 0,
                        opts.allowNsfw ? 1 : 0,
                    ],
                }),
            catch: (err) => new DbError({ message: `Failed to add Reddit feed: ${err}` }),
        });
    });

export const removeRedditFeed = (groupId: number, subreddit: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "DELETE FROM reddit_feeds WHERE group_id = ? AND subreddit = ?",
                    args: [groupId, subreddit.toLowerCase()],
                }),
            catch: (err) => new DbError({ message: `Failed to remove Reddit feed: ${err}` }),
        });
        return (result.rowsAffected ?? 0) > 0;
    });

export const editRedditFeed = (feedId: number, opts: EditFeedOptions) =>
    Effect.gen(function* () {
        if (Object.keys(opts).length === 0) return;
        const db = yield* Db;
        const parts: string[] = [];
        const args: (string | number | null)[] = [];
        if (opts.enabled !== undefined) { parts.push("enabled = ?"); args.push(opts.enabled ? 1 : 0); }
        if (opts.intervalMins !== undefined) { parts.push("interval_mins = ?"); args.push(opts.intervalMins); }
        if (opts.weight !== undefined) { parts.push("weight = ?"); args.push(opts.weight); }
        if (opts.source !== undefined) { parts.push("source = ?"); args.push(opts.source); }
        if (opts.fetchComments !== undefined) { parts.push("fetch_comments = ?"); args.push(opts.fetchComments ? 1 : 0); }
        if (opts.allowNsfw !== undefined) { parts.push("allow_nsfw = ?"); args.push(opts.allowNsfw ? 1 : 0); }
        if (parts.length === 0) return;
        args.push(feedId);
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `UPDATE reddit_feeds SET ${parts.join(", ")} WHERE id = ?`,
                    args,
                }),
            catch: (err) => new DbError({ message: `Failed to edit Reddit feed: ${err}` }),
        });
    });

export const editAllFeedsInGroup = (groupId: number, opts: BulkFeedOptions) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const parts: string[] = [];
        const args: (string | number | null)[] = [];
        if (opts.intervalMins !== undefined) { parts.push("interval_mins = ?"); args.push(opts.intervalMins); }
        if (opts.weight !== undefined) { parts.push("weight = ?"); args.push(opts.weight); }
        if (opts.source !== undefined) { parts.push("source = ?"); args.push(opts.source); }
        if (opts.fetchComments !== undefined) { parts.push("fetch_comments = ?"); args.push(opts.fetchComments ? 1 : 0); }
        if (opts.allowNsfw !== undefined) { parts.push("allow_nsfw = ?"); args.push(opts.allowNsfw ? 1 : 0); }
        if (parts.length === 0) return 0;
        args.push(groupId);
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `UPDATE reddit_feeds SET ${parts.join(", ")} WHERE group_id = ?`,
                    args,
                }),
            catch: (err) => new DbError({ message: `Failed to bulk-edit feeds in group: ${err}` }),
        });
        return result.rowsAffected ?? 0;
    });

export const getRedditFeed = (groupId: number, subreddit: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `SELECT id, group_id, subreddit, enabled, interval_mins, weight, source,
                                 time_filter, fetch_comments, allow_nsfw, last_checked_at
                          FROM reddit_feeds WHERE group_id = ? AND subreddit = ?`,
                    args: [groupId, subreddit.toLowerCase()],
                }),
            catch: (err) => new DbError({ message: `Failed to get Reddit feed: ${err}` }),
        });
        const row = result.rows[0];
        return row ? rowToFeed(row as Record<string, unknown>) : undefined;
    });

export const listRedditFeeds = (groupId: number) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `SELECT id, group_id, subreddit, enabled, interval_mins, weight, source,
                                 time_filter, fetch_comments, allow_nsfw, last_checked_at
                          FROM reddit_feeds WHERE group_id = ? ORDER BY subreddit`,
                    args: [groupId],
                }),
            catch: (err) => new DbError({ message: `Failed to list Reddit feeds: ${err}` }),
        });
        return result.rows.map((r) => rowToFeed(r as Record<string, unknown>));
    });

export const getAllActiveFeeds = () =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute(`
                    SELECT f.id, f.group_id, f.subreddit, f.enabled, f.interval_mins,
                           f.weight, f.source, f.time_filter, f.fetch_comments, f.allow_nsfw, f.last_checked_at,
                           g.guild_id, g.channel_id, g.name AS group_name, g.algorithm
                    FROM reddit_feeds f
                    JOIN reddit_groups g ON g.id = f.group_id
                    WHERE f.enabled = 1
                    ORDER BY g.id, f.subreddit
                `),
            catch: (err) => new DbError({ message: `Failed to get all active feeds: ${err}` }),
        });
        return result.rows.map((row) => rowToFeedWithGroup(row as Record<string, unknown>));
    });

export const updateFeedLastChecked = (feedId: number, timestamp: number) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "UPDATE reddit_feeds SET last_checked_at = ? WHERE id = ?",
                    args: [timestamp, feedId],
                }),
            catch: (err) => new DbError({ message: `Failed to update feed last_checked_at: ${err}` }),
        });
    });

export const getSeenPostIds = (groupId: number) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT post_id FROM reddit_seen WHERE group_id = ?",
                    args: [groupId],
                }),
            catch: (err) => new DbError({ message: `Failed to get seen posts: ${err}` }),
        });
        return new Set(result.rows.map((r) => r["post_id"] as string));
    });

export const markPostsSeen = (groupId: number, postIds: string[]) =>
    Effect.gen(function* () {
        if (postIds.length === 0) return;
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.batch(
                    postIds.map((id) => ({
                        sql: "INSERT OR IGNORE INTO reddit_seen (group_id, post_id) VALUES (?, ?)",
                        args: [groupId, id] as [number, string],
                    })),
                    "write"
                ),
            catch: (err) => new DbError({ message: `Failed to mark posts as seen: ${err}` }),
        });
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `DELETE FROM reddit_seen
                          WHERE group_id = ? AND post_id NOT IN (
                              SELECT post_id FROM reddit_seen
                              WHERE group_id = ?
                              ORDER BY seen_at DESC
                              LIMIT 2000
                          )`,
                    args: [groupId, groupId],
                }),
            catch: () => new DbError({ message: "" }),
        }).pipe(Effect.ignore);
    });

export const AIGENICK_EMBEDDING_DIMS = 1536;

export const initAigenickDb = Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise({
        try: () =>
            db.batch(
                [
                    `CREATE TABLE IF NOT EXISTS aigenick_cache (
                        guild_id      TEXT    NOT NULL,
                        user_id       TEXT    NOT NULL,
                        nickname      TEXT    NOT NULL,
                        message_count INTEGER NOT NULL,
                        embedding     F32_BLOB(${AIGENICK_EMBEDDING_DIMS}),
                        created_at    INTEGER NOT NULL,
                        PRIMARY KEY (guild_id, user_id)
                    )`,
                    `CREATE INDEX IF NOT EXISTS aigenick_cache_vec_idx
                        ON aigenick_cache (libsql_vector_idx(embedding))`,
                    `CREATE TABLE IF NOT EXISTS aigenick_guild_cooldown (
                        guild_id     TEXT    PRIMARY KEY,
                        last_used_at INTEGER NOT NULL
                    )`,
                ],
                "write"
            ),
        catch: (err) => new DbError({ message: `Failed to init aigenick schema: ${err}` }),
    });
});

export type AigenickCacheEntry = {
    nickname: string;
    messageCount: number;
    createdAt: number;
    distance: number;
};

export const getAigenickEntry = (guildId: string, userId: string, embeddingJson: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `SELECT nickname, message_count, created_at,
                                 vector_distance_cos(embedding, vector32(?)) AS dist
                          FROM aigenick_cache
                          WHERE guild_id = ? AND user_id = ?`,
                    args: [embeddingJson, guildId, userId],
                }),
            catch: (err) => new DbError({ message: `Failed to get aigenick entry: ${err}` }),
        });
        const row = result.rows[0];
        if (!row) return undefined;
        return {
            nickname: row.nickname as string,
            messageCount: row.message_count as number,
            createdAt: row.created_at as number,
            distance: row.dist as number,
        } satisfies AigenickCacheEntry;
    });

export const setAigenickEntry = (
    guildId: string,
    userId: string,
    nickname: string,
    messageCount: number,
    embeddingJson: string,
) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `INSERT INTO aigenick_cache (guild_id, user_id, nickname, message_count, embedding, created_at)
                          VALUES (?, ?, ?, ?, vector32(?), ?)
                          ON CONFLICT(guild_id, user_id) DO UPDATE SET
                              nickname      = excluded.nickname,
                              message_count = excluded.message_count,
                              embedding     = excluded.embedding,
                              created_at    = excluded.created_at`,
                    args: [guildId, userId, nickname, messageCount, embeddingJson, Date.now()],
                }),
            catch: (err) => new DbError({ message: `Failed to set aigenick entry: ${err}` }),
        });
    });

export const getGuildCooldown = (guildId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: "SELECT last_used_at FROM aigenick_guild_cooldown WHERE guild_id = ?",
                    args: [guildId],
                }),
            catch: (err) => new DbError({ message: `Failed to get guild cooldown: ${err}` }),
        });
        return result.rows[0]?.last_used_at as number | undefined;
    });

export const setGuildCooldown = (guildId: string) =>
    Effect.gen(function* () {
        const db = yield* Db;
        yield* Effect.tryPromise({
            try: () =>
                db.execute({
                    sql: `INSERT INTO aigenick_guild_cooldown (guild_id, last_used_at)
                          VALUES (?, ?)
                          ON CONFLICT(guild_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
                    args: [guildId, Date.now()],
                }),
            catch: (err) => new DbError({ message: `Failed to set guild cooldown: ${err}` }),
        });
    });
