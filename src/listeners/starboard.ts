import { Listener, Events } from "@sapphire/framework";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    type MessageReaction,
    type PartialMessageReaction,
    type PartialUser,
    TextChannel,
    type User,
} from "discord.js";
import { Effect } from "effect";
import { AppLayer } from "../index.js";
import {
    getStarboardConfig,
    getStarboardEntry,
    isStarboardMessage,
    saveStarboardEntry,
} from "../lib/db.js";

export class StarboardListener extends Listener<typeof Events.MessageReactionAdd> {
    public constructor(context: Listener.LoaderContext) {
        super(context, { event: Events.MessageReactionAdd });
    }

    public async run(
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ) {
        if (reaction.partial) {
            try {
                reaction = await reaction.fetch();
            } catch {
                return;
            }
        }

        const message = reaction.message.partial
            ? await reaction.message.fetch().catch(() => null)
            : reaction.message;

        if (!message) return;
        if (!message.guild) return;
        if (user.bot) return;

        const guildId = message.guild.id;

        await Effect.runPromise(
            Effect.gen(function* () {
                const config = yield* getStarboardConfig(guildId);
                if (!config) return;

                if (message.channelId === config.channelId) return;

                const alreadyStarboardMsg = yield* isStarboardMessage(message.id);
                if (alreadyStarboardMsg) return;

                const reactionCount = reaction.count ?? 0;
                if (reactionCount < config.minReactions) return;

                const existing = yield* getStarboardEntry(message.id);
                if (existing) return;

                const starboardChannel = message.guild!.channels.cache.get(config.channelId) as
                    | TextChannel
                    | undefined;
                if (!starboardChannel?.isSendable()) return;

                const author = message.author;
                if (!author) return;

                const embed = new EmbedBuilder()
                    .setColor(0xffd700)
                    .setAuthor({
                        name: author.username,
                        iconURL: author.displayAvatarURL(),
                    })
                    .setTimestamp(message.createdAt)
                    .setFooter({
                        text: `#${"name" in message.channel ? message.channel.name : "unknown"}`,
                    });

                if (message.content) embed.setDescription(message.content);

                const imageAttachment = message.attachments.find((a) =>
                    a.contentType?.startsWith("image/")
                );
                if (imageAttachment) embed.setImage(imageAttachment.url);

                const nonImageAttachments = message.attachments.filter(
                    (a) => !a.contentType?.startsWith("image/")
                );
                if (nonImageAttachments.size > 0) {
                    embed.addFields({
                        name: "Attachments",
                        value: nonImageAttachments.map((a) => `[${a.name}](${a.url})`).join("\n"),
                    });
                }

                if (message.stickers.size > 0) {
                    embed.addFields({
                        name: "Sticker",
                        value: message.stickers.map((s) => s.name).join(", "),
                    });
                }

                const jumpButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setLabel("Jump to Message")
                        .setStyle(ButtonStyle.Link)
                        .setURL(message.url)
                );

                const sent = yield* Effect.tryPromise({
                    try: () =>
                        starboardChannel.send({
                            embeds: [embed],
                            components: [jumpButton],
                        }),
                    catch: (err) => new Error(`Failed to send starboard message: ${err}`),
                });

                yield* saveStarboardEntry(message.id, sent.id, guildId);
            }).pipe(Effect.provide(AppLayer), Effect.catchAll(() => Effect.void))
        );
    }
}
