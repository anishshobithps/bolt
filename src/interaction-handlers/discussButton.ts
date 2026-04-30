import { InteractionHandler, InteractionHandlerTypes } from "@sapphire/framework";
import { ThreadAutoArchiveDuration, type ButtonInteraction } from "discord.js";

export class DiscussButtonHandler extends InteractionHandler {
    public constructor(ctx: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
        super(ctx, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
    }

    public override parse(interaction: ButtonInteraction) {
        if (!interaction.customId.startsWith("discuss:")) return this.none();
        return this.some(interaction.customId.slice(8));
    }

    public async run(interaction: ButtonInteraction, threadName: string) {
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch {
            return;
        }

        try {
            const msg = interaction.message;

            if (msg.thread) {
                await interaction.editReply({
                    content: `💬 Discussion thread: ${msg.thread.url}`,
                });
                return;
            }

            const thread = await msg.startThread({
                name: (threadName || "Discussion").slice(0, 100),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
                reason: "Reddit discussion thread",
            });

            await interaction.editReply({ content: `💬 Thread created: ${thread.url}` });
        } catch {
            await interaction.editReply({ content: "❌ Couldn't create thread. The bot may be missing permissions." });
        }
    }
}
