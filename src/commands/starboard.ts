import { Command } from "@sapphire/framework";
import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { Effect } from "effect";
import { AppLayer } from "../index.js";
import { setStarboardChannel, setStarboardThreshold, removeStarboardChannel } from "../lib/db.js";

export class StarboardCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, { ...options, name: "starboard" });
    }

    public override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand(
            (builder) =>
                builder
                    .setName("starboard")
                    .setDescription("Configure the starboard")
                    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
                    .addSubcommand((sub) =>
                        sub
                            .setName("set")
                            .setDescription("Set the channel where starred messages are posted")
                            .addChannelOption((opt) =>
                                opt
                                    .setName("channel")
                                    .setDescription("The channel to use as starboard")
                                    .addChannelTypes(ChannelType.GuildText)
                                    .setRequired(true)
                            )
                            .addIntegerOption((opt) =>
                                opt
                                    .setName("min-reactions")
                                    .setDescription("Minimum total reactions before a message is posted (default: 1)")
                                    .setMinValue(1)
                                    .setMaxValue(100)
                                    .setRequired(false)
                            )
                    )
                    .addSubcommand((sub) =>
                        sub
                            .setName("threshold")
                            .setDescription("Change the minimum reaction count without changing the channel")
                            .addIntegerOption((opt) =>
                                opt
                                    .setName("min-reactions")
                                    .setDescription("Minimum total reactions before a message is posted")
                                    .setMinValue(1)
                                    .setMaxValue(100)
                                    .setRequired(true)
                            )
                    )
                    .addSubcommand((sub) =>
                        sub.setName("unset").setDescription("Disable the starboard for this server")
                    ),
            { idHints: ["1499158513719574711"] }
        );
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: "❌ Server only.", flags: MessageFlags.Ephemeral }).catch(() => null);
            return;
        }

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch {
            return;
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "set") {
            const channel = interaction.options.getChannel("channel", true);
            const minReactions = interaction.options.getInteger("min-reactions") ?? 1;

            await Effect.runPromise(
                setStarboardChannel(interaction.guildId, channel.id, minReactions).pipe(
                    Effect.provide(AppLayer)
                )
            );

            await interaction.editReply({
                content: `✅ Starboard set to <#${channel.id}>\n-# ${minReactions} reaction(s) required`,
            });
        } else if (sub === "threshold") {
            const minReactions = interaction.options.getInteger("min-reactions", true);

            await Effect.runPromise(
                setStarboardThreshold(interaction.guildId, minReactions).pipe(
                    Effect.provide(AppLayer)
                )
            );

            await interaction.editReply({
                content: `✅ Threshold updated → **${minReactions}** reaction(s)`,
            });
        } else if (sub === "unset") {
            await Effect.runPromise(
                removeStarboardChannel(interaction.guildId).pipe(Effect.provide(AppLayer))
            );

            await interaction.editReply({ content: "✅ Starboard **disabled** for this server" });
        }
    }
}
