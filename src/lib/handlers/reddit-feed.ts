import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { Effect } from "effect";
import { AppLayer } from "../../index.js";
import {
    addRedditFeed,
    editRedditFeed,
    getRedditFeed,
    listRedditFeeds,
    removeRedditFeed,
    type PostSource,
} from "../db.js";
import { validateSubreddit } from "../reddit.js";
import { resolveGroup } from "./reddit-util.js";

export async function handleFeedAdd(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const groupName = interaction.options.getString("group", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const subreddit = interaction.options.getString("subreddit", true).trim().replace(/^r\//i, "");
    const intervalMins = interaction.options.getInteger("interval") ?? 45;
    const weight = interaction.options.getInteger("weight") ?? 1;
    const source = (interaction.options.getString("source") ?? "hot") as PostSource;
    const fetchComments = interaction.options.getBoolean("comments") ?? false;
    const allowNsfw = interaction.options.getBoolean("nsfw") ?? false;

    const group = await resolveGroup(interaction, groupName, channel.id);
    if (!group) return;

    if (allowNsfw) {
        const ch = interaction.guild?.channels.cache.get(channel.id) as TextChannel | undefined;
        if (!ch?.nsfw) {
            await interaction.editReply({
                content: `⚠️ <#${channel.id}> is not marked **Age-Restricted**\n-# Enable it in channel settings or NSFW posts will be silently skipped`,
            });
            return;
        }
    }

    await interaction.editReply({ content: `🔍 Validating r/${subreddit}…` });
    const validation = await Effect.runPromise(validateSubreddit(subreddit));
    if (!validation.valid) {
        await interaction.editReply({ content: `❌ r/${subreddit} — ${validation.reason}` });
        return;
    }

    try {
        await Effect.runPromise(
            addRedditFeed(group.id, subreddit, {
                intervalMins,
                weight,
                source,
                fetchComments,
                allowNsfw,
            }).pipe(Effect.provide(AppLayer))
        );
    } catch (err: unknown) {
        if (String(err).toLowerCase().includes("unique")) {
            await interaction.editReply({ content: `❌ **r/${subreddit}** is already in **${groupName}**` });
            return;
        }
        throw err;
    }

    await interaction.editReply({
        content: `✅ **r/${subreddit}** added to **${groupName}** in <#${channel.id}>\n-# Every ${intervalMins}m · weight ${weight} · ${source}${fetchComments ? " · 💬 comments" : ""}${allowNsfw ? " · 🔞 nsfw" : ""}`,
    });
}

export async function handleFeedRemove(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const groupName = interaction.options.getString("group", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const subreddit = interaction.options.getString("subreddit", true).trim().replace(/^r\//i, "");

    const group = await resolveGroup(interaction, groupName, channel.id);
    if (!group) return;

    const removed = await Effect.runPromise(
        removeRedditFeed(group.id, subreddit).pipe(Effect.provide(AppLayer))
    );

    await interaction.editReply(
        removed
            ? { content: `✅ **r/${subreddit}** removed from **${groupName}**` }
            : { content: `❌ **r/${subreddit}** not found in **${groupName}**` }
    );
}

export async function handleFeedEdit(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const groupName = interaction.options.getString("group", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const subreddit = interaction.options.getString("subreddit", true).trim().replace(/^r\//i, "");

    const group = await resolveGroup(interaction, groupName, channel.id);
    if (!group) return;

    const feed = await Effect.runPromise(
        getRedditFeed(group.id, subreddit).pipe(Effect.provide(AppLayer))
    );
    if (!feed) {
        await interaction.editReply({ content: `❌ **r/${subreddit}** is not in **${groupName}**` });
        return;
    }

    const enabled = interaction.options.getBoolean("enabled");
    const intervalMins = interaction.options.getInteger("interval");
    const weight = interaction.options.getInteger("weight");
    const source = interaction.options.getString("source") as PostSource | null;
    const fetchComments = interaction.options.getBoolean("comments");
    const allowNsfw = interaction.options.getBoolean("nsfw");

    const opts = {
        ...(enabled !== null && { enabled: enabled! }),
        ...(intervalMins !== null && { intervalMins: intervalMins! }),
        ...(weight !== null && { weight: weight! }),
        ...(source !== null && { source: source! }),
        ...(fetchComments !== null && { fetchComments: fetchComments! }),
        ...(allowNsfw !== null && { allowNsfw: allowNsfw! }),
    };

    if (Object.keys(opts).length === 0) {
        await interaction.editReply({ content: "⚠️ No changes specified" });
        return;
    }

    await Effect.runPromise(editRedditFeed(feed.id, opts).pipe(Effect.provide(AppLayer)));

    const changes = [
        enabled !== null && `enabled → **${enabled}**`,
        intervalMins !== null && `interval → **${intervalMins}m**`,
        weight !== null && `weight → **${weight}**`,
        source !== null && `source → **${source}**`,
        fetchComments !== null && `comments → **${fetchComments}**`,
        allowNsfw !== null && `nsfw → **${allowNsfw}**`,
    ]
        .filter(Boolean)
        .join(" · ");

    await interaction.editReply({
        content: `✅ **r/${subreddit}** updated in **${groupName}**\n-# ${changes}`,
    });
}

export async function handleFeedList(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply(); } catch { return; }

    const groupName = interaction.options.getString("group", true).trim();
    const channel = interaction.options.getChannel("channel", true);

    const group = await resolveGroup(interaction, groupName, channel.id);
    if (!group) return;

    const feeds = await Effect.runPromise(
        listRedditFeeds(group.id).pipe(Effect.provide(AppLayer))
    );

    if (feeds.length === 0) {
        await interaction.editReply({
            content: `**${groupName}** has no feeds yet\n-# Add one with \`/reddit feed add\``,
        });
        return;
    }

    const rows = feeds.map((f) => {
        const flags = [
            f.fetchComments && "💬",
            f.allowNsfw && "🔞",
            !f.enabled && "⏸️",
        ].filter(Boolean).join(" ");
        const status = f.enabled ? "🟢" : "🔴";
        const intervalStr = f.intervalMins % 60 === 0 ? `${f.intervalMins / 60}h` : `${f.intervalMins}m`;
        return `${status} **r/${f.subreddit}** — every ${intervalStr} · wt ${f.weight} · ${f.source} ${flags}`.trimEnd();
    });

    const embed = new EmbedBuilder()
        .setTitle(`Group "${groupName}" feeds`)
        .setDescription(rows.join("\n"))
        .setColor(0xff4500)
        .addFields({ name: "Channel", value: `<#${channel.id}>`, inline: true })
        .setFooter({ text: `${feeds.length} subreddit(s) · 🟢 on · 🔴 off · 💬 comments · 🔞 nsfw` });

    await interaction.editReply({ embeds: [embed] });
}
