import { Effect } from "effect";
import type { ChatInputCommandInteraction } from "discord.js";
import { AppLayer } from "../../index.js";
import { getRedditGroup, type RedditGroup } from "../db.js";

export async function resolveGroup(
    interaction: ChatInputCommandInteraction,
    groupName: string,
    channelId: string
): Promise<RedditGroup | undefined> {
    const group = await Effect.runPromise(
        getRedditGroup(interaction.guildId!, channelId, groupName).pipe(Effect.provide(AppLayer))
    );
    if (!group) {
        await interaction.editReply({
            content: `❌ No group **${groupName}** in <#${channelId}>\n-# Create one with \`/reddit group create\``,
        });
    }
    return group;
}
