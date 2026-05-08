import { Data, Effect, Schedule, Schema } from "effect";
import { type PostSource } from "./db.js";

export { type PostSource };

const REDDIT_BASE = "https://www.reddit.com";
const VX_REDDIT_BASE = "https://vxreddit.com";
const FIX_REDDIT_BASE = "https://rxddit.com";
const USER_AGENT = "bolt-discord-bot/1.0";

export class RedditError extends Data.TaggedError("RedditError")<{
    readonly reason: string;
}> { }

export const RedditPostSchema = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    author: Schema.String,
    url: Schema.String,
    permalink: Schema.String,
    isVideo: Schema.Boolean,
    isSelf: Schema.Boolean,
    selftext: Schema.String,
    score: Schema.Number,
    upvoteRatio: Schema.Number,
    numComments: Schema.Number,
    subreddit: Schema.String,
    createdUtc: Schema.Number,
    preview: Schema.optional(Schema.String),
    nsfw: Schema.Boolean,
    galleryImages: Schema.optional(Schema.Array(Schema.String)),
});
export type RedditPost = Schema.Schema.Type<typeof RedditPostSchema>;

export const RedditCommentSchema = Schema.Struct({
    id: Schema.String,
    author: Schema.String,
    body: Schema.String,
    score: Schema.Number,
});
export type RedditComment = Schema.Schema.Type<typeof RedditCommentSchema>;

export const SubredditValidationSchema = Schema.Struct({
    valid: Schema.Boolean,
    reason: Schema.optional(Schema.String),
});
export type SubredditValidation = Schema.Schema.Type<typeof SubredditValidationSchema>;

export function rewriteUrl(url: string, base: string): string {
    return url
        .replace(/^https?:\/\/(?:www\.)?reddit\.com/, base)
        .replace(/^https?:\/\/(?:www\.)?redd\.it/, base);
}

export function toVxReddit(url: string): string {
    return rewriteUrl(url, VX_REDDIT_BASE);
}

let _embedBase: string | undefined;
let _embedBaseExpiresAt = 0;
const EMBED_BASE_TTL_MS = 5 * 60 * 1_000;

export const resolveEmbedBase = (): Effect.Effect<string, never> =>
    Effect.gen(function* () {
        const now = Date.now();
        if (_embedBase && now < _embedBaseExpiresAt) return _embedBase;

        const fixUp = yield* Effect.tryPromise({
            try: async () => {
                const res = await fetch(FIX_REDDIT_BASE, {
                    method: "HEAD",
                    signal: AbortSignal.timeout(5_000),
                });
                return res.status < 500;
            },
            catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));

        _embedBase = fixUp ? FIX_REDDIT_BASE : VX_REDDIT_BASE;
        _embedBaseExpiresAt = now + EMBED_BASE_TTL_MS;
        return _embedBase;
    });

export function scorePost(post: RedditPost, weight: number): number {
    const upvoteScore = Math.min(300, Math.log10(Math.max(1, post.score)) * 100);
    const ratioScore = post.upvoteRatio * 50;
    const engagementRatio = post.score > 0 ? post.numComments / post.score : 0;
    const engagementScore = Math.min(30, engagementRatio * 100);
    const ageHours = (Date.now() / 1_000 - post.createdUtc) / 3_600;
    const freshnessScore = ageHours < 2 ? 20 : ageHours < 6 ? 10 : ageHours < 24 ? 0 : -10;
    return (upvoteScore + ratioScore + engagementScore + freshnessScore) * weight;
}

const retrySchedule = Schedule.exponential("1 second").pipe(
    Schedule.intersect(Schedule.recurs(3)),
    Schedule.whileInput((err: RedditError) =>
        err.reason.startsWith("HTTP_429") || err.reason.startsWith("HTTP_5")
    )
);

const decodePost = Schema.decodeUnknown(RedditPostSchema);
const decodeComment = Schema.decodeUnknown(RedditCommentSchema);

const redditFetch = (url: string): Effect.Effect<unknown, RedditError> =>
    Effect.tryPromise({
        try: async () => {
            const res = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const snippet = body.slice(0, 200).replace(/\s+/g, " ").trim();
                throw new Error(`HTTP_${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`);
            }
            return await res.json() as unknown;
        },
        catch: (err) => new RedditError({ reason: err instanceof Error ? err.message : String(err) }),
    }).pipe(
        Effect.retry(retrySchedule)
    );

function parseGalleryImages(p: Record<string, unknown>): string[] | undefined {
    const metadata = p["media_metadata"] as Record<string, unknown> | undefined;
    const galleryData = p["gallery_data"] as { items?: { media_id: string }[] } | undefined;
    if (!metadata || !galleryData?.items) return undefined;

    const urls: string[] = [];
    for (const item of galleryData.items) {
        const entry = metadata[item.media_id] as Record<string, unknown> | undefined;
        if (!entry || entry["e"] !== "Image") continue;
        const src = (entry["s"] as Record<string, unknown> | undefined);
        const url = src?.["u"] as string | undefined;
        if (url) urls.push(url.replace(/&amp;/g, "&"));
    }
    return urls.length > 0 ? urls : undefined;
}

export const fetchPosts = (
    subreddit: string,
    source: PostSource,
    limit = 25
): Effect.Effect<RedditPost[], RedditError> =>
    Effect.gen(function* () {
        const data = yield* redditFetch(`${REDDIT_BASE}/r/${subreddit}/${source}.json?limit=${limit}`);

        const children =
            (((data as Record<string, unknown>)?.["data"] as Record<string, unknown>)?.["children"] as unknown[]) ?? [];

        const posts: RedditPost[] = [];

        for (const child of children) {
            const p = (child as Record<string, unknown>)?.["data"] as Record<string, unknown>;

            const crossposts = p?.["crosspost_parent_list"] as unknown[] | undefined;
            if (crossposts && crossposts.length > 0) continue;

            const previewImages =
                (((p?.["preview"] as Record<string, unknown>)?.["images"]) as unknown[]) ?? [];
            const firstImage = previewImages[0] as Record<string, unknown> | undefined;
            const preview = ((firstImage?.["source"] as Record<string, unknown>)?.["url"] as string | undefined)
                ?.replace(/&amp;/g, "&");

            const raw = {
                id: (p["id"] as string) ?? "",
                title: (p["title"] as string) ?? "Untitled",
                author: (p["author"] as string) ?? "[deleted]",
                url: (p["url"] as string) ?? "",
                permalink: `${REDDIT_BASE}${p["permalink"] as string}`,
                isVideo: Boolean(p["is_video"]),
                isSelf: Boolean(p["is_self"]),
                selftext: (p["selftext"] as string) ?? "",
                score: (p["score"] as number) ?? 0,
                upvoteRatio: (p["upvote_ratio"] as number) ?? 0.5,
                numComments: (p["num_comments"] as number) ?? 0,
                subreddit: (p["subreddit"] as string) ?? subreddit,
                createdUtc: (p["created_utc"] as number) ?? 0,
                preview,
                nsfw: Boolean(p["over_18"]),
                galleryImages: parseGalleryImages(p),
            };

            const post = yield* decodePost(raw).pipe(
                Effect.mapError((err) => new RedditError({ reason: String(err) }))
            );
            posts.push(post);
        }

        return posts;
    });

export const fetchTopComments = (
    postId: string,
    subreddit: string,
    limit = 5
): Effect.Effect<RedditComment[], never> =>
    Effect.gen(function* () {
        const data = yield* redditFetch(
            `${REDDIT_BASE}/r/${subreddit}/comments/${postId}.json?sort=top&limit=${limit + 5}&depth=1`
        );

        const commentListing = (data as unknown[])?.[1] as Record<string, unknown> | undefined;
        const children =
            ((commentListing?.["data"] as Record<string, unknown>)?.["children"] as unknown[]) ?? [];

        const comments: RedditComment[] = [];

        for (const c of children) {
            const cd = c as Record<string, unknown>;
            const d = cd["data"] as Record<string, unknown>;

            if (
                cd["kind"] !== "t1" ||
                d["author"] === "[deleted]" ||
                d["body"] === "[deleted]" ||
                d["body"] === "[removed]" ||
                typeof d["body"] !== "string"
            ) continue;

            const raw = {
                id: d["id"] as string,
                author: d["author"] as string,
                body: d["body"] as string,
                score: (d["score"] as number) ?? 0,
            };

            const comment = yield* decodeComment(raw).pipe(
                Effect.mapError((err) => new RedditError({ reason: String(err) }))
            );
            comments.push(comment);
            if (comments.length >= limit) break;
        }

        return comments;
    }).pipe(Effect.orElseSucceed(() => []));

export const validateSubreddit = (subreddit: string): Effect.Effect<SubredditValidation, never> =>
    Effect.gen(function* () {
        if (!/^[A-Za-z0-9_]{3,21}$/.test(subreddit)) {
            return { valid: false as const, reason: "Invalid name — must be 3-21 alphanumeric/underscore characters." };
        }

        return yield* redditFetch(`${REDDIT_BASE}/r/${subreddit}/about.json`).pipe(
            Effect.map((data) => {
                const d = data as Record<string, unknown>;
                if (d?.["kind"] !== "t5") return { valid: false as const, reason: "Subreddit not found." };
                const info = d?.["data"] as Record<string, unknown> | undefined;
                if (info?.["subreddit_type"] === "private") return { valid: false as const, reason: "Subreddit is private." };
                if (info?.["subreddit_type"] === "restricted") return { valid: false as const, reason: "Subreddit is restricted." };
                return { valid: true as const };
            }),
            Effect.catchAll((err) =>
                Effect.succeed(
                    err.reason === "NOT_FOUND" ? { valid: false as const, reason: "Subreddit does not exist." } :
                        err.reason === "FORBIDDEN" ? { valid: false as const, reason: "Access forbidden." } :
                            err.reason === "RATE_LIMITED" ? { valid: false as const, reason: "Reddit API rate-limited — try again shortly." } :
                                { valid: false as const, reason: "Could not reach Reddit API." }
                )
            )
        );
    });
