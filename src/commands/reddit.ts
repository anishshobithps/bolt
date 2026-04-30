import { Command } from "@sapphire/framework";
import { ChannelType, MessageFlags, PermissionFlagsBits, type AutocompleteInteraction } from "discord.js";
import { Effect } from "effect";
import { AppLayer, guildId } from "../index.js";
import { getRedditGroup, listRedditFeeds, listRedditGroups } from "../lib/db.js";
import { ROTATION_ALGORITHM_CHOICES } from "../lib/reddit-rotation.js";
import {
    handleGroupCreate,
    handleGroupDelete,
    handleGroupList,
    handleGroupAlgorithm,
    handleGroupEdit,
    handleGroupLock,
} from "../lib/handlers/reddit-group.js";
import {
    handleFeedAdd,
    handleFeedRemove,
    handleFeedEdit,
    handleFeedList,
} from "../lib/handlers/reddit-feed.js";

const INTERVAL_PRESETS = [
    { name: "15 min  (minimum)", value: 15 },
    { name: "30 min", value: 30 },
    { name: "45 min  (default)", value: 45 },
    { name: "1 hour", value: 60 },
    { name: "1.5 hours", value: 90 },
    { name: "2 hours", value: 120 },
    { name: "3 hours", value: 180 },
    { name: "4 hours", value: 240 },
    { name: "6 hours", value: 360 },
    { name: "12 hours", value: 720 },
    { name: "24 hours", value: 1440 },
] as const;

export class RedditCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, { ...options, name: "reddit" });
    }

    public override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand(
            (builder) =>
                builder
                    .setName("reddit")
                    .setDescription("Manage automated Reddit feed subscriptions")
                    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
                    .addSubcommand((sub) =>
                        sub.setName("help").setDescription("Show the full Reddit feed system guide")
                    )
                    .addSubcommandGroup((group) =>
                        group
                            .setName("group")
                            .setDescription("Manage rotation groups (one pool per channel)")
                            .addSubcommand((sub) =>
                                sub
                                    .setName("create")
                                    .setDescription("Create a new rotation group in a channel")
                                    .addStringOption((opt) =>
                                        opt.setName("name").setDescription("Unique group name (e.g. gaming)").setRequired(true).setMinLength(1).setMaxLength(32)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel for this group's posts").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("algorithm").setDescription("Rotation algorithm (default: weighted-random)").setRequired(false)
                                            .addChoices(...ROTATION_ALGORITHM_CHOICES)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("edit")
                                    .setDescription("Edit group algorithm and/or bulk-update all its feeds at once")
                                    .addStringOption((opt) =>
                                        opt.setName("name").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("algorithm").setDescription("New rotation algorithm for this group").setRequired(false)
                                            .addChoices(...ROTATION_ALGORITHM_CHOICES)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("interval").setDescription("Set interval for ALL feeds in group (min: 15)").setMinValue(15).setRequired(false).setAutocomplete(true)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("weight").setDescription("Set weight for ALL feeds in group (1–100)").setMinValue(1).setMaxValue(100).setRequired(false)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("source").setDescription("Set source for ALL feeds in group").setRequired(false)
                                            .addChoices({ name: "Hot", value: "hot" }, { name: "New", value: "new" })
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("comments").setDescription("Toggle comment threads for ALL feeds in group").setRequired(false)
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("nsfw").setDescription("Toggle NSFW for ALL feeds in group").setRequired(false)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("delete")
                                    .setDescription("Delete a group and all its feeds")
                                    .addStringOption((opt) =>
                                        opt.setName("name").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("list")
                                    .setDescription("List all groups in this server")
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Filter by channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("algorithm")
                                    .setDescription("Change the rotation algorithm for an existing group")
                                    .addStringOption((opt) =>
                                        opt.setName("name").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("algorithm").setDescription("Rotation algorithm").setRequired(true)
                                            .addChoices(...ROTATION_ALGORITHM_CHOICES)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("lock")
                                    .setDescription("Lock all reddit channels — members can only chat inside threads")
                            )
                    )
                    .addSubcommandGroup((group) =>
                        group
                            .setName("feed")
                            .setDescription("Manage subreddit feeds within a group")
                            .addSubcommand((sub) =>
                                sub
                                    .setName("add")
                                    .setDescription("Add a subreddit to a group")
                                    .addStringOption((opt) =>
                                        opt.setName("group").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("subreddit").setDescription("Subreddit name (without r/)").setRequired(true).setMinLength(3).setMaxLength(21)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("interval").setDescription("Min minutes between posts from this subreddit (default: 45)").setMinValue(15).setRequired(false).setAutocomplete(true)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("weight").setDescription("Rotation priority weight — higher = selected more often (default: 1)").setMinValue(1).setMaxValue(100).setRequired(false)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("source").setDescription("Post sort (default: hot)").setRequired(false)
                                            .addChoices({ name: "Hot", value: "hot" }, { name: "New", value: "new" })
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("comments").setDescription("Post top 5 comments as a thread (default: false)").setRequired(false)
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("nsfw").setDescription("Allow NSFW posts — channel must also be NSFW (default: false)").setRequired(false)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("remove")
                                    .setDescription("Remove a subreddit from a group")
                                    .addStringOption((opt) =>
                                        opt.setName("group").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("subreddit").setDescription("Subreddit name (without r/)").setRequired(true).setAutocomplete(true)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("edit")
                                    .setDescription("Edit settings for a subreddit feed")
                                    .addStringOption((opt) =>
                                        opt.setName("group").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("subreddit").setDescription("Subreddit name (without r/)").setRequired(true).setAutocomplete(true)
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("enabled").setDescription("Enable or pause this feed").setRequired(false)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("interval").setDescription("Min minutes between posts (min: 15)").setMinValue(15).setRequired(false).setAutocomplete(true)
                                    )
                                    .addIntegerOption((opt) =>
                                        opt.setName("weight").setDescription("Rotation priority weight").setMinValue(1).setMaxValue(100).setRequired(false)
                                    )
                                    .addStringOption((opt) =>
                                        opt.setName("source").setDescription("Post sort").setRequired(false)
                                            .addChoices({ name: "Hot", value: "hot" }, { name: "New", value: "new" })
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("comments").setDescription("Toggle comment threads").setRequired(false)
                                    )
                                    .addBooleanOption((opt) =>
                                        opt.setName("nsfw").setDescription("Allow NSFW posts — channel must also be NSFW").setRequired(false)
                                    )
                            )
                            .addSubcommand((sub) =>
                                sub
                                    .setName("list")
                                    .setDescription("List all feeds in a group")
                                    .addStringOption((opt) =>
                                        opt.setName("group").setDescription("Group name").setRequired(true).setAutocomplete(true)
                                    )
                                    .addChannelOption((opt) =>
                                        opt.setName("channel").setDescription("Channel the group belongs to").addChannelTypes(ChannelType.GuildText).setRequired(true)
                                    )
                            )
                    ),
            { idHints: [], guildIds: guildId ? [guildId] : [] }
        );
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: "❌ Server only.", flags: MessageFlags.Ephemeral }).catch(() => null);
            return;
        }

        const subgroup = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        if (!subgroup && sub === "help") {
            await interaction.reply({ content: REDDIT_HELP_TEXT, flags: MessageFlags.Ephemeral }).catch(() => null);
            return;
        }

        if (subgroup === "group") {
            const dispatch: Record<string, (i: Command.ChatInputCommandInteraction) => Promise<void>> = {
                create: handleGroupCreate,
                edit: handleGroupEdit,
                delete: handleGroupDelete,
                list: handleGroupList,
                algorithm: handleGroupAlgorithm,
                lock: handleGroupLock,
            };
            await dispatch[sub]?.(interaction);
            return;
        }

        if (subgroup === "feed") {
            const dispatch: Record<string, (i: Command.ChatInputCommandInteraction) => Promise<void>> = {
                add: handleFeedAdd,
                remove: handleFeedRemove,
                edit: handleFeedEdit,
                list: handleFeedList,
            };
            await dispatch[sub]?.(interaction);
            return;
        }
    }

    public override async autocompleteRun(interaction: AutocompleteInteraction): Promise<void> {
        const focused = interaction.options.getFocused(true);
        const subgroup = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const gId = interaction.guildId;
        if (!gId) { await interaction.respond([]); return; }

        try {
            if (focused.name === "name" || focused.name === "group") {
                const channelId = interaction.options.get("channel")?.value as string | undefined;
                const groups = await Effect.runPromise(
                    listRedditGroups(gId, channelId).pipe(Effect.provide(AppLayer))
                );
                const q = String(focused.value).toLowerCase();
                const seen = new Set<string>();
                const choices = groups
                    .filter((g) => {
                        if (seen.has(g.name)) return false;
                        seen.add(g.name);
                        return !q || g.name.toLowerCase().includes(q);
                    })
                    .slice(0, 25)
                    .map((g) => ({ name: g.name, value: g.name }));
                await interaction.respond(choices);
                return;
            }

            if (focused.name === "subreddit" && subgroup === "feed" && (sub === "remove" || sub === "edit")) {
                const channelId = interaction.options.get("channel")?.value as string | undefined;
                const groupName = interaction.options.get("group")?.value as string | undefined;
                if (!channelId || !groupName) { await interaction.respond([]); return; }
                const group = await Effect.runPromise(
                    getRedditGroup(gId, channelId, String(groupName)).pipe(Effect.provide(AppLayer))
                );
                if (!group) { await interaction.respond([]); return; }
                const feeds = await Effect.runPromise(
                    listRedditFeeds(group.id).pipe(Effect.provide(AppLayer))
                );
                const q = String(focused.value).toLowerCase();
                const choices = feeds
                    .filter((f) => !q || f.subreddit.toLowerCase().includes(q))
                    .slice(0, 25)
                    .map((f) => ({
                        name: `r/${f.subreddit}${f.enabled ? "" : " (paused)"}  ·  every ${f.intervalMins}m  ·  w${f.weight}`,
                        value: f.subreddit,
                    }));
                await interaction.respond(choices);
                return;
            }

            if (focused.name === "interval") {
                const q = String(focused.value);
                const choices = q
                    ? INTERVAL_PRESETS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || String(p.value).startsWith(q))
                    : INTERVAL_PRESETS;
                await interaction.respond([...choices].slice(0, 25));
                return;
            }
        } catch {
        }

        await interaction.respond([]);
    }
}

const REDDIT_HELP_TEXT = [
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
