import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { Effect } from "effect";
import { AppLayer } from "../../index.js";
import {
    createRedditGroup,
    deleteRedditGroup,
    editAllFeedsInGroup,
    listRedditGroups,
    setGroupAlgorithm,
    type BulkFeedOptions,
    type PostSource,
} from "../db.js";
import { ROTATION_ALGORITHM_CHOICES, type RotationAlgorithm } from "../reddit-rotation.js";
import { resolveGroup } from "./reddit-util.js";

export async function handleGroupCreate(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const name = interaction.options.getString("name", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const algorithm = (interaction.options.getString("algorithm") ?? "weighted-random") as RotationAlgorithm;

    try {
        await Effect.runPromise(
            createRedditGroup(interaction.guildId!, channel.id, name, algorithm).pipe(Effect.provide(AppLayer))
        );

        let permNote = "";
        try {
            const ch = (interaction.guild?.channels.cache.get(channel.id)
                ?? await interaction.guild?.channels.fetch(channel.id)) as TextChannel | null | undefined;
            if (ch && "permissionOverwrites" in ch) {
                await ch.permissionOverwrites.edit(interaction.guild!.roles.everyone, {
                    SendMessages: false,
                    SendMessagesInThreads: true,
                    CreatePublicThreads: false,
                });
                permNote = "\n-# 🔒 Channel locked — members can only chat inside threads";
            }
        } catch {
            permNote = "\n-# ⚠️ Couldn't set channel permissions — bot needs **Manage Channels**";
        }

        await interaction.editReply({
            content: `✅ **${name}** created in <#${channel.id}> with \`${algorithm}\` rotation${permNote}`,
        });
    } catch (err: unknown) {
        if (String(err).toLowerCase().includes("unique")) {
            await interaction.editReply({ content: `❌ **${name}** already exists in <#${channel.id}>` });
        } else throw err;
    }
}

export async function handleGroupDelete(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const name = interaction.options.getString("name", true).trim();
    const channel = interaction.options.getChannel("channel", true);

    const deleted = await Effect.runPromise(
        deleteRedditGroup(interaction.guildId!, channel.id, name).pipe(Effect.provide(AppLayer))
    );

    await interaction.editReply(
        deleted
            ? { content: `✅ **${name}** deleted from <#${channel.id}>\n-# All feeds removed` }
            : { content: `❌ No group **${name}** in <#${channel.id}>` }
    );
}

export async function handleGroupList(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply(); } catch { return; }

    const channel = interaction.options.getChannel("channel");

    const groups = await Effect.runPromise(
        listRedditGroups(interaction.guildId!, channel?.id).pipe(Effect.provide(AppLayer))
    );

    if (groups.length === 0) {
        await interaction.editReply({
            content: channel
                ? `No groups in <#${channel.id}>\n-# Create one with \`/reddit group create\``
                : `No groups in this server\n-# Create one with \`/reddit group create\``,
        });
        return;
    }

    const byChannel = new Map<string, typeof groups>();
    for (const g of groups) {
        const list = byChannel.get(g.channelId) ?? [];
        list.push(g);
        byChannel.set(g.channelId, list);
    }

    const embed = new EmbedBuilder()
        .setTitle("Reddit Rotation Groups")
        .setColor(0xff4500)
        .setFooter({ text: `${groups.length} group(s)` });

    for (const [cid, gs] of byChannel) {
        embed.addFields({
            name: `<#${cid}>`,
            value: gs.map((g) => `• **${g.name}** — ${g.algorithm}`).join("\n"),
            inline: false,
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleGroupAlgorithm(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const name = interaction.options.getString("name", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const algorithm = interaction.options.getString("algorithm", true) as RotationAlgorithm;

    const updated = await Effect.runPromise(
        setGroupAlgorithm(interaction.guildId!, channel.id, name, algorithm).pipe(Effect.provide(AppLayer))
    );

    await interaction.editReply(
        updated
            ? { content: `✅ **${name}** → \`${algorithm}\` rotation\n-# <#${channel.id}>` }
            : { content: `❌ No group **${name}** in <#${channel.id}>` }
    );
}

export async function handleGroupEdit(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const name = interaction.options.getString("name", true).trim();
    const channel = interaction.options.getChannel("channel", true);
    const algorithm = interaction.options.getString("algorithm") as RotationAlgorithm | null;
    const intervalMins = interaction.options.getInteger("interval");
    const weight = interaction.options.getInteger("weight");
    const source = interaction.options.getString("source") as PostSource | null;
    const fetchComments = interaction.options.getBoolean("comments");
    const allowNsfw = interaction.options.getBoolean("nsfw");

    const hasGroupChange = algorithm !== null;
    const bulkOpts: BulkFeedOptions = {
        ...(intervalMins !== null && { intervalMins: intervalMins! }),
        ...(weight !== null && { weight: weight! }),
        ...(source !== null && { source: source! }),
        ...(fetchComments !== null && { fetchComments: fetchComments! }),
        ...(allowNsfw !== null && { allowNsfw: allowNsfw! }),
    };
    const hasFeedChanges = Object.keys(bulkOpts).length > 0;

    if (!hasGroupChange && !hasFeedChanges) {
        await interaction.editReply({ content: "⚠️ No changes specified" });
        return;
    }

    const group = await resolveGroup(interaction, name, channel.id);
    if (!group) return;

    const changes: string[] = [];

    if (algorithm !== null) {
        const updated = await Effect.runPromise(
            setGroupAlgorithm(interaction.guildId!, channel.id, name, algorithm).pipe(Effect.provide(AppLayer))
        );
        if (updated) changes.push(`algorithm → \`${algorithm}\``);
    }

    if (hasFeedChanges) {
        const affected = await Effect.runPromise(
            editAllFeedsInGroup(group.id, bulkOpts).pipe(Effect.provide(AppLayer))
        );
        if (intervalMins !== null) changes.push(`interval → **${intervalMins}m**`);
        if (weight !== null) changes.push(`weight → **${weight}**`);
        if (source !== null) changes.push(`source → **${source}**`);
        if (fetchComments !== null) changes.push(`comments → **${fetchComments}**`);
        if (allowNsfw !== null) changes.push(`nsfw → **${allowNsfw}**`);
        if (affected > 0) changes.push(`-# Applied to ${affected} feed(s)`);
    }

    await interaction.editReply({
        content: `✅ **${name}** updated\n-# ${changes.join(" · ")}`,
    });
}

export async function handleGroupLock(interaction: ChatInputCommandInteraction) {
    try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

    const groups = await Effect.runPromise(
        listRedditGroups(interaction.guildId!).pipe(Effect.provide(AppLayer))
    );

    if (groups.length === 0) {
        await interaction.editReply({ content: "No groups in this server." });
        return;
    }

    const seen = new Set<string>();
    const results: string[] = [];

    for (const g of groups) {
        if (seen.has(g.channelId)) continue;
        seen.add(g.channelId);
        try {
            const ch = (interaction.guild?.channels.cache.get(g.channelId)
                ?? await interaction.guild?.channels.fetch(g.channelId)) as TextChannel | null | undefined;
            if (ch && "permissionOverwrites" in ch) {
                await ch.permissionOverwrites.edit(interaction.guild!.roles.everyone, {
                    SendMessages: false,
                    SendMessagesInThreads: true,
                    CreatePublicThreads: false,
                });
                results.push(`✅ <#${g.channelId}>`);
            } else {
                results.push(`⚠️ <#${g.channelId}> — not a text channel`);
            }
        } catch {
            results.push(`❌ <#${g.channelId}> — missing Manage Channels permission`);
        }
    }

    await interaction.editReply({
        content: `### 🔒 Channel Lock Results\n${results.join("\n")}`,
    });
}

export { ROTATION_ALGORITHM_CHOICES };
