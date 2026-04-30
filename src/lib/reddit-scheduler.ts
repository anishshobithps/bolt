import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ThreadAutoArchiveDuration,
    type Client,
    type TextChannel,
    type AnyThreadChannel,
} from "discord.js";
import { Data, Effect } from "effect";
import { AppLayer } from "../index.js";
import {
    getAllActiveFeeds,
    getSeenPostIds,
    markPostsSeen,
    updateFeedLastChecked,
    type RedditFeedWithGroup,
} from "./db.js";
import {
    fetchPosts,
    fetchTopComments,
    resolveEmbedBase,
    rewriteUrl,
    scorePost,
    type RedditComment,
    type RedditPost,
} from "./reddit.js";
import { rotationSelector } from "./reddit-rotation.js";


class SchedulerError extends Data.TaggedError("SchedulerError")<{
    readonly reason: string;
}> { }


function buildPostEmbed(post: RedditPost, embedBase: string): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(0xff4500)
        .setTitle(post.title.slice(0, 256))
        .setURL(rewriteUrl(post.permalink, embedBase))
        .setAuthor({ name: `📍 r/${post.subreddit}  ·  👤 u/${post.author}` })
        .setFooter({
            text: `⬆️ ${post.score.toLocaleString()}  ·  💬 ${post.numComments.toLocaleString()}  ·  ${Math.round(post.upvoteRatio * 100)}% upvoted`,
        })
        .setTimestamp(post.createdUtc * 1_000);

    if (post.isSelf && post.selftext.length > 0) {
        embed.setDescription(post.selftext.slice(0, EMBED_DESC_LIMIT));
    } else if (!post.isSelf && !post.isVideo) {
        const isDirectImage = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(post.url);
        const isGallery = post.url.includes("/gallery/");
        if (isDirectImage) {
            embed.setImage(post.url);
        } else if (post.galleryImages && post.galleryImages.length > 0) {
            embed.setImage(post.galleryImages[0]!);
        } else if (post.preview) {
            embed.setImage(post.preview);
        }
    }

    if (post.isVideo && post.preview) embed.setImage(post.preview);

    return embed;
}

const MSG_LIMIT = 2000;
const EMBED_DESC_LIMIT = 4096;

async function sendSelftextOverflow(thread: AnyThreadChannel, selftext: string): Promise<void> {
    const overflow = selftext.slice(EMBED_DESC_LIMIT);
    for (let i = 0; i < overflow.length; i += MSG_LIMIT) {
        await thread.send({ content: overflow.slice(i, i + MSG_LIMIT) });
    }
}

async function sendCommentMessages(thread: AnyThreadChannel, comments: RedditComment[]): Promise<void> {
    if (comments.length === 0) return;
    await thread.send({ content: "### 💬 Top Comments" });
    for (const c of comments) {
        const body = c.body.split("\n").map((l) => `> ${l || "\u200b"}`).join("\n");
        const msg = `**u/${c.author}** · ⬆️ ${c.score.toLocaleString()}\n${body}`;
        for (let i = 0; i < msg.length; i += MSG_LIMIT) {
            await thread.send({ content: msg.slice(i, i + MSG_LIMIT) });
        }
    }
}

async function sendGalleryImages(thread: AnyThreadChannel, images: string[]): Promise<void> {
    for (let i = 0; i < images.length; i += 10) {
        const chunk = images.slice(i, i + 10);
        const files = await Promise.all(
            chunk.map(async (url, idx) => {
                const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
                const buf = Buffer.from(await res.arrayBuffer());
                const ext = url.split("?")[0]!.split(".").pop() ?? "jpg";
                return new AttachmentBuilder(buf, { name: `image_${i + idx + 1}.${ext}` });
            })
        );
        await thread.send({ files });
    }
}


const processGroup = Effect.fn("processGroup")(function* (
    client: Client,
    groupId: number,
    channelId: string,
    feeds: RedditFeedWithGroup[]
) {
    const now = Math.floor(Date.now() / 1_000);
    const due = feeds.filter((f) => now - f.lastCheckedAt >= f.intervalMins * 60);
    if (due.length === 0) return;

    const selected = rotationSelector.select(groupId, due, feeds[0]!.algorithm);
    if (!selected) return;

    const embedBase = yield* resolveEmbedBase();

    const channel = yield* Effect.tryPromise({
        try: () => client.channels.fetch(channelId),
        catch: (err) => new SchedulerError({ reason: `Channel fetch failed: ${err}` }),
    });
    if (!channel || !("send" in channel)) return;
    const textChannel = channel as TextChannel;

    const posts = yield* fetchPosts(selected.subreddit, selected.source, 25).pipe(
        Effect.mapError((err) => new SchedulerError({ reason: err.reason }))
    );

    const seenIds = yield* getSeenPostIds(groupId);

    const isChannelNsfw = "nsfw" in textChannel && Boolean((textChannel as unknown as { nsfw: boolean }).nsfw);

    const candidates = posts
        .filter((p) => !seenIds.has(p.id))
        .filter((p) => {
            if (!p.nsfw) return true;
            if (!selected.allowNsfw) return false;
            return isChannelNsfw;
        });

    if (candidates.length === 0) {
        yield* updateFeedLastChecked(selected.id, now);
        return;
    }

    const scored = candidates
        .map((p) => ({ post: p, score: scorePost(p, selected.weight) }))
        .sort((a, b) => b.score - a.score);

    const pick = scored.slice(0, 5)[Math.floor(Math.random() * Math.min(5, scored.length))]!.post;

    const selftextOverflow = pick.isSelf && pick.selftext.length > EMBED_DESC_LIMIT;

    const message = yield* Effect.tryPromise({
        try: () => {
            const hasExtraGallery = (pick.galleryImages?.length ?? 0) > 1;
            const showButton = !selected.fetchComments && !hasExtraGallery && !selftextOverflow;

            const isDirectImage = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(pick.url);
            const isGallery = pick.url.includes("/gallery/");
            const vxLink = rewriteUrl(pick.url, embedBase);
            const vxPerma = rewriteUrl(pick.permalink, embedBase);
            const hasExternalLink = !pick.isVideo && !pick.isSelf && !isDirectImage && !isGallery && vxLink !== vxPerma;

            const buttons: ButtonBuilder[] = [];
            if (showButton) {
                buttons.push(
                    new ButtonBuilder()
                        .setCustomId(`discuss:${pick.title.slice(0, 92)}`)
                        .setLabel("💬 Discuss")
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            if (hasExternalLink) {
                buttons.push(
                    new ButtonBuilder()
                        .setLabel("🔗 Link")
                        .setURL(vxLink)
                        .setStyle(ButtonStyle.Link)
                );
            }
            const components = buttons.length > 0
                ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
                : [];

            if (pick.isVideo) {
                const stats = `-# 👤 u/${pick.author}  ·  📍 r/${pick.subreddit}  ·  ⬆️ ${pick.score.toLocaleString()}  ·  💬 ${pick.numComments.toLocaleString()}  ·  ${Math.round(pick.upvoteRatio * 100)}% upvoted`;
                const perma = rewriteUrl(pick.permalink, embedBase);
                return textChannel.send({
                    content: `### [${pick.title}](${perma})\n${stats}`,
                    ...(components.length > 0 ? { components } : {}),
                });
            }

            return textChannel.send({
                embeds: [buildPostEmbed(pick, embedBase)],
                ...(components.length > 0 ? { components } : {}),
            });
        },
        catch: (err) => new SchedulerError({ reason: `Send failed: ${err}` }),
    });

    yield* updateFeedLastChecked(selected.id, now);
    yield* markPostsSeen(groupId, [pick.id]);

    const extraImages = pick.galleryImages && pick.galleryImages.length > 1
        ? pick.galleryImages.slice(1)
        : [];

    if (selected.fetchComments || extraImages.length > 0 || selftextOverflow) {
        const comments = selected.fetchComments
            ? yield* fetchTopComments(pick.id, pick.subreddit, 5)
            : [];
        yield* Effect.tryPromise({
            try: async () => {
                const thread = await message.startThread({
                    name: pick.title.slice(0, 96),
                    autoArchiveDuration: selected.fetchComments
                        ? ThreadAutoArchiveDuration.OneHour
                        : ThreadAutoArchiveDuration.OneDay,
                    reason: "Reddit discussion",
                });
                if (selftextOverflow) {
                    await sendSelftextOverflow(thread, pick.selftext);
                }
                if (comments.length > 0) {
                    await sendCommentMessages(thread, comments);
                }
                if (extraImages.length > 0) {
                    const totalImages = pick.galleryImages?.length ?? extraImages.length + 1;
                    await thread.send({ content: `### 🖼️ Gallery\n-# ${totalImages} images` });
                    await sendGalleryImages(thread, extraImages);
                }
            },
            catch: (err) => new SchedulerError({ reason: `Thread failed: ${err}` }),
        });
    }
});


export class RedditScheduler {
    private intervalId: ReturnType<typeof setInterval> | undefined;
    private running = false;

    start(client: Client): void {
        if (this.running) return;
        this.running = true;
        setTimeout(() => Effect.runFork(this.tick(client)), 5_000);
        this.intervalId = setInterval(() => Effect.runFork(this.tick(client)), 60_000);
    }

    stop(): void {
        if (this.intervalId !== undefined) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.running = false;
    }

    private tick(client: Client): Effect.Effect<void, never> {
        return Effect.gen(function* () {
            const allFeeds = yield* getAllActiveFeeds();

            if (allFeeds.length === 0) return;

            const byGroup = new Map<number, RedditFeedWithGroup[]>();
            for (const feed of allFeeds) {
                const list = byGroup.get(feed.groupId) ?? [];
                list.push(feed);
                byGroup.set(feed.groupId, list);
            }

            for (const [groupId, feeds] of byGroup) {
                yield* processGroup(client, groupId, feeds[0]!.channelId, feeds).pipe(
                    Effect.catchAll((err) =>
                        Effect.sync(() => console.error(`[RedditScheduler] Group ${groupId} error:`, err))
                    )
                );
                yield* Effect.sleep("2 seconds");
            }
        }).pipe(
            Effect.provide(AppLayer),
            Effect.catchAll((err) =>
                Effect.sync(() => console.error("[RedditScheduler] Tick error:", err))
            )
        );
    }
}

export const redditScheduler = new RedditScheduler();
