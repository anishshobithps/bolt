import { AllFlowsPrecondition } from "@sapphire/framework";
import { Team } from "discord.js";
import type { CommandInteraction, ContextMenuCommandInteraction, Message, Snowflake } from "discord.js";

/**
 * Resolves the set of owner IDs directly from the Discord application API.
 * Handles both solo-owner apps and team-owned apps (all team members are treated as owners).
 * The result is cached after the first successful fetch so the API is only hit once per process lifecycle.
 */
export class OwnerOnlyPrecondition extends AllFlowsPrecondition {
    #ownerIds: Set<Snowflake> | null = null;

    public override chatInputRun(interaction: CommandInteraction) {
        return this.#checkOwner(interaction.user.id);
    }

    public override contextMenuRun(interaction: ContextMenuCommandInteraction) {
        return this.#checkOwner(interaction.user.id);
    }

    public override messageRun(message: Message) {
        return this.#checkOwner(message.author.id);
    }

    async #checkOwner(userId: Snowflake) {
        const ownerIds = await this.#fetchOwnerIds();
        return ownerIds.has(userId)
            ? this.ok()
            : this.error({ message: "This command can only be used by the bot owner." });
    }

    async #fetchOwnerIds(): Promise<Set<Snowflake>> {
        if (this.#ownerIds !== null) return this.#ownerIds;

        // Fetch fresh application data from the Discord API (not cached client data)
        const app = await this.container.client.application!.fetch();
        const ids = new Set<Snowflake>();

        if (app.owner instanceof Team) {
            // Team-owned app: every team member is considered an owner
            for (const member of app.owner.members.values()) {
                ids.add(member.user.id);
            }
        } else if (app.owner !== null) {
            // Solo-owner app
            ids.add(app.owner.id);
        }

        this.#ownerIds = ids;
        return ids;
    }
}

declare module "@sapphire/framework" {
    interface Preconditions {
        OwnerOnly: never;
    }
}
