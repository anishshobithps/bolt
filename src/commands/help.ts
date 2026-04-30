import { Command } from "@sapphire/framework";
import { MessageFlags } from "discord.js";
import { guildId } from "../index.js";

const OVERVIEW_TEXT = [
    "### Bolt — Command Reference",
    "Use `/help topic:<name>` for detailed info on each module.",
    "",
    "**📰 Reddit Feeds** — `/reddit help` or `/help topic:reddit`",
    "Automate subreddit rotation into any channel. Groups, weights, NSFW gating, comment threads, and quality scoring.",
    "",
    "**⭐ Starboard** — `/help topic:starboard`",
    "Automatically repost highly-reacted messages to a dedicated starboard channel.",
    "",
    "**🔒 Permissions** — Most admin commands require **Manage Server**.",
].join("\n");

const REDDIT_TEXT = [
    "### 📰 Reddit Feed System",
    "Auto-posts curated subreddit content. Crossposts and seen posts are skipped. Links use **vxReddit**.",
    "",
    "**Concepts** — **Group**: named pool tied to a channel · **Feed**: subreddit with interval/weight/source/nsfw · **Weight**: higher = chosen more often · **Interval**: min minutes before re-posting",
    "",
    "**🗂️ Group Commands**",
    "```",
    "/reddit group create  name:<n> channel:#ch [algorithm:<a>]",
    "/reddit group edit    name:<n> channel:#ch [algorithm] [interval] [weight] [source] [comments] [nsfw]",
    "/reddit group delete  name:<n> channel:#ch",
    "/reddit group list    [channel:#ch]  ·  /reddit group lock",
    "```",
    "`group edit` bulk-applies all options to **every feed** in the group at once.",
    "",
    "**📰 Feed Commands**",
    "```",
    "/reddit feed add|edit  group:<n> channel:#ch subreddit:<sub> [options]",
    "/reddit feed remove    group:<n> channel:#ch subreddit:<sub>",
    "/reddit feed list      group:<n> channel:#ch",
    "```",
    "Options: `interval` ≥15 (def 45) · `weight` 1–100 (def 1) · `source` hot/new · `comments` bool · `nsfw` bool · `enabled` (edit only)",
    "",
    "**🔞 NSFW** — set `nsfw:true` on the feed + mark the channel **Age-Restricted** in Discord or NSFW posts are silently skipped.",
    "",
    "**💡 Example**",
    "```",
    "/reddit group create name:gaming channel:#gaming",
    "/reddit feed add group:gaming channel:#gaming subreddit:pcgaming interval:120 weight:3 comments:true",
    "/reddit group edit name:gaming channel:#gaming interval:60 weight:2",
    "```",
    "`pcgaming` posts every 2h with comment threads. `group edit` sets every feed to 60m / weight 2 at once.",
    "",
    "**🔒 Permissions** — All `/reddit` commands require **Manage Server**.",
].join("\n");

const STARBOARD_TEXT = [
    "### ⭐ Starboard",
    "When a message gets enough reactions **with the same emoji**, it is automatically reposted to the starboard channel.",
    "",
    "**⚙️ Commands**",
    "```",
    "/starboard set       channel:#ch [threshold:<n>]",
    "/starboard threshold <n>",
    "/starboard unset",
    "```",
    "- `/starboard set` — Set the starboard channel; optionally set the reaction threshold at the same time.",
    "- `/starboard threshold` — Update the minimum count without changing the channel.",
    "- `/starboard unset` — Disable the starboard for this server.",
    "",
    "**ℹ️ Notes**",
    "- The reaction count is checked **per emoji** — it is the count of the single emoji that triggered the event, not the total of all reactions.",
    "- Each message can only appear on the starboard once.",
    "- Messages already in the starboard channel are never re-posted.",
    "- Default threshold is `1` (any single reaction triggers it).",
    "",
    "**💡 Example**",
    "```",
    "/starboard set channel:#starboard threshold:5",
    "```",
    "Any message that gets 5 or more of the same emoji in a non-starboard channel will be reposted.",
    "",
    "**🔒 Permissions** — All `/starboard` commands require **Manage Server**.",
].join("\n");

const TOPICS: Record<string, string> = {
    overview: OVERVIEW_TEXT,
    reddit: REDDIT_TEXT,
    starboard: STARBOARD_TEXT,
};

export class HelpCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, { ...options, name: "help" });
    }

    public override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand(
            (builder) =>
                builder
                    .setName("help")
                    .setDescription("Show bot commands and documentation")
                    .addStringOption((opt) =>
                        opt
                            .setName("topic")
                            .setDescription("Topic to get detailed help for")
                            .setRequired(false)
                            .addChoices(
                                { name: "Reddit Feeds", value: "reddit" },
                                { name: "Starboard", value: "starboard" }
                            )
                    ),
            { idHints: [], guildIds: guildId ? [guildId] : [] }
        );
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        const topic = interaction.options.getString("topic") ?? "overview";
        const text = TOPICS[topic] ?? TOPICS["overview"]!;
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
}
