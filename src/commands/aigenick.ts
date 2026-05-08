import { Command } from "@sapphire/framework";
import { ChannelType, type GuildMember, PermissionFlagsBits, type TextChannel } from "discord.js";
import { Data, Effect } from "effect";
import { AppLayer } from "../index.js";
import {
    getAigenickEntry,
    getGuildCooldown,
    setAigenickEntry,
    setGuildCooldown,
} from "../lib/db.js";

const MAX_MESSAGES = 100;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
const FETCH_DELAY_MS = 150;
const MODEL = "google/gemma-3-27b-it";
const EMBED_MODEL = "openai/text-embedding-3-small";
const MAX_PAGES_PER_CHANNEL = 5;
const GUILD_COOLDOWN_MS = 30_000;
const VECTOR_DISTANCE_THRESHOLD = 0.12;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export class MissingApiKeyError extends Data.TaggedError("MissingApiKeyError")<Record<never, never>> { }

export class DiscordFetchError extends Data.TaggedError("DiscordFetchError")<{
    readonly reason: string;
}> { }

export class OpenRouterError extends Data.TaggedError("OpenRouterError")<{
    readonly status: number;
    readonly body: string;
}> { }

export class NicknameSetError extends Data.TaggedError("NicknameSetError")<{
    readonly reason: string;
}> { }

export class CooldownError extends Data.TaggedError("CooldownError")<{
    readonly remainingMs: number;
}> { }

const collectUserMessages = (member: GuildMember, maxCount: number) =>
    Effect.gen(function* () {
        const guild = member.guild;
        const collected: string[] = [];

        const textChannels = [...guild.channels.cache.values()].filter(
            (ch): ch is TextChannel =>
                ch.type === ChannelType.GuildText &&
                ch.viewable &&
                ch
                    .permissionsFor(guild.members.me!)
                    ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) === true,
        );

        for (const channel of textChannels) {
            if (collected.length >= maxCount) break;

            let before: string | undefined;

            for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
                if (collected.length >= maxCount) break;

                const fetched = yield* Effect.tryPromise({
                    try: () => channel.messages.fetch({ limit: 100, before }),
                    catch: () => new DiscordFetchError({ reason: `Cannot read #${channel.name}` }),
                }).pipe(Effect.option);

                if (fetched._tag !== "Some" || fetched.value.size === 0) break;

                const sorted = [...fetched.value.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

                for (const msg of sorted) {
                    if (collected.length >= maxCount) break;
                    if (msg.author.id === member.id && msg.content.trim().length > 0) {
                        const cleaned = msg.content
                            .replace(/<@!?\d+>/g, "")
                            .replace(/<#\d+>/g, "")
                            .replace(/<@&\d+>/g, "")
                            .replace(/\s{2,}/g, " ")
                            .trim();
                        if (cleaned.length > 0) collected.push(cleaned);
                    }
                }

                before = fetched.value.last()?.id;
                if (fetched.value.size < 100) break;

                yield* Effect.sleep(FETCH_DELAY_MS);
            }

            yield* Effect.sleep(FETCH_DELAY_MS);
        }

        return collected;
    });

const generateEmbedding = (text: string) =>
    Effect.gen(function* () {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return yield* new MissingApiKeyError();

        const response = yield* Effect.tryPromise({
            try: () =>
                fetch(OPENROUTER_EMBED_URL, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://github.com/anishshobithps/bolt",
                        "X-Title": "Bolt Discord Bot",
                    },
                    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
                }),
            catch: (err) => new OpenRouterError({ status: 0, body: String(err) }),
        });

        if (!response.ok) {
            const body = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new OpenRouterError({ status: response.status, body: "(unreadable)" }),
            }).pipe(Effect.orElseSucceed(() => "(unreadable)"));
            return yield* new OpenRouterError({ status: response.status, body });
        }

        const data = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: (err) => new OpenRouterError({ status: 200, body: String(err) }),
        });

        const embedding =
            data !== null &&
            typeof data === "object" &&
            "data" in data &&
            Array.isArray((data as { data: unknown }).data) &&
            (data as { data: Array<{ embedding: number[] }> }).data[0]?.embedding;

        if (!embedding || !Array.isArray(embedding)) {
            return yield* new OpenRouterError({ status: 200, body: `Unexpected embedding response: ${JSON.stringify(data)}` });
        }

        return embedding;
    });

const SYSTEM_PROMPT =
    "You are a savage, unfiltered roast comedian. Your only job is to output a single Discord nickname. " +
    "Rules: write ONLY the nickname — no punctuation at the very end, no quotes, no explanation, no tags, no special tokens, no XML, no angle brackets, no markdown. " +
    "The nickname must be plain ASCII printable text, max 32 characters. Swearing and vulgarity are fully allowed and encouraged. " +
    "If the messages are in a non-English language (Hindi, Marathi, Tamil, etc.), translate the vibe/meaning into an English nickname — do NOT transliterate, make it land in English.";

const ARTIFACT_RE = /<[^>]*>|\|[a-z_]+\||[\x00-\x1F\x7F]/g;

function sanitizeNickname(raw: string): string {
    return raw
        .replace(ARTIFACT_RE, "")
        .replace(/[^\x20-\x7E]/g, "")
        .trim()
        .slice(0, 32)
        .trim();
}

const generateNickname = (messages: string[], username: string) =>
    Effect.gen(function* () {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return yield* new MissingApiKeyError();

        const userPrompt =
            messages.length > 0
                ? `Roast the Discord user "${username}" based on their messages below. Give them a brutally funny, unhinged, absurdist nickname in English (even if the messages are in another language — capture the vibe in English). Swearing is welcome. Max 32 characters. Output ONLY the nickname.\n\nMessages:\n${messages.join("\n")}`
                : `The Discord user "${username}" has sent ZERO messages. They are a ghost, a lurker, a void-dweller. Give them a hilariously savage English nickname mocking their silence. Swearing is welcome. Max 32 characters. Output ONLY the nickname.`;

        const response = yield* Effect.tryPromise({
            try: () =>
                fetch(OPENROUTER_API_URL, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://github.com/anishshobithps/bolt",
                        "X-Title": "Bolt Discord Bot",
                    },
                    body: JSON.stringify({
                        model: MODEL,
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: userPrompt },
                        ],
                        max_tokens: 24,
                        temperature: 1.1,
                        stop: ["\n", "<", "|"],
                    }),
                }),
            catch: (err) => new OpenRouterError({ status: 0, body: String(err) }),
        });

        if (!response.ok) {
            const body = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new OpenRouterError({ status: response.status, body: "(unreadable)" }),
            }).pipe(Effect.orElseSucceed(() => "(unreadable)"));
            return yield* new OpenRouterError({ status: response.status, body });
        }

        const data = yield* Effect.tryPromise({
            try: () =>
                response.json() as Promise<{
                    choices: Array<{ message: { content: string } }>;
                }>,
            catch: (err) => new OpenRouterError({ status: 200, body: String(err) }),
        });

        const raw = data.choices[0]?.message?.content ?? "";
        const nickname = sanitizeNickname(raw);
        return nickname.length > 0 ? nickname : "Chronically Online Gremlin";
    });

export class AiGenNickCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, { ...options, name: "aigenick" });
    }

    public override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand((builder) =>
            builder
                .setName("aigenick")
                .setDescription("Let AI read your messages and roast you with a new nickname")
                .setDefaultMemberPermissions(PermissionFlagsBits.ChangeNickname)
                .addUserOption((opt) =>
                    opt
                        .setName("target")
                        .setDescription("Member to rename — requires Manage Nicknames permission")
                        .setRequired(false),
                ),
        );
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        if (!interaction.guild || !(interaction.member instanceof Object)) {
            return interaction.reply({
                content: "❌ This command can only be used inside a server.",
            });
        }

        const invoker = interaction.member as GuildMember;
        const targetUser = interaction.options.getUser("target");

        if (targetUser && targetUser.id !== interaction.user.id) {
            if (!invoker.permissions.has(PermissionFlagsBits.ManageNicknames)) {
                return interaction.reply({
                    content: "❌ You need the **Manage Nicknames** permission to rename other members.",
                });
            }
        }

        await interaction.deferReply();

        const program = Effect.gen(function* () {
            const lastUsed = yield* getGuildCooldown(interaction.guildId!);
            if (lastUsed !== undefined && Date.now() - lastUsed < GUILD_COOLDOWN_MS) {
                return yield* new CooldownError({ remainingMs: GUILD_COOLDOWN_MS - (Date.now() - lastUsed) });
            }

            const targetMember = yield* (() => {
                if (targetUser && targetUser.id !== interaction.user.id) {
                    return Effect.tryPromise({
                        try: () => interaction.guild!.members.fetch(targetUser.id),
                        catch: () => new DiscordFetchError({ reason: "Member not found in this server." }),
                    }).pipe(
                        Effect.flatMap((member) => {
                            const isOwner = interaction.guild!.ownerId === interaction.user.id;
                            if (!isOwner && member.roles.highest.position >= invoker.roles.highest.position) {
                                return Effect.fail(
                                    new DiscordFetchError({
                                        reason: "You cannot rename a member whose highest role is equal to or above yours.",
                                    }),
                                );
                            }
                            return Effect.succeed(member);
                        }),
                    );
                }
                return Effect.succeed(invoker);
            })();

            const messages = yield* collectUserMessages(targetMember, MAX_MESSAGES);
            const embedInput = messages.length > 0 ? messages.join(" ") : "silent lurker no messages";
            const embedding = yield* generateEmbedding(embedInput);
            const embeddingJson = JSON.stringify(embedding);

            const cached = yield* getAigenickEntry(interaction.guildId!, targetMember.id, embeddingJson);
            const now = Date.now();

            let nickname: string;
            let fromCache = false;

            if (
                cached !== undefined &&
                now - cached.createdAt < CACHE_MAX_AGE_MS &&
                cached.distance < VECTOR_DISTANCE_THRESHOLD
            ) {
                nickname = cached.nickname;
                fromCache = true;
            } else {
                yield* setGuildCooldown(interaction.guildId!);
                nickname = yield* generateNickname(messages, targetMember.user.username);
                yield* setAigenickEntry(interaction.guildId!, targetMember.id, nickname, messages.length, embeddingJson);
            }

            yield* Effect.tryPromise({
                try: () =>
                    targetMember.setNickname(
                        nickname,
                        `AI nickname${fromCache ? " (cached)" : ""} by ${interaction.user.tag}`,
                    ),
                catch: (err) => new NicknameSetError({ reason: String(err) }),
            });

            const isSelf = targetMember.id === interaction.user.id;
            const cacheNote = fromCache ? " *(from cache — your vibe hasn't changed)*" : "";

            yield* Effect.tryPromise({
                try: () =>
                    interaction.editReply({
                        content: isSelf
                            ? `🤖 Analysed **${messages.length}** message(s) and the AI has spoken.${cacheNote}\nYou are now known as: **${nickname}**`
                            : `🤖 Analysed **${messages.length}** message(s) from ${targetMember.toString()} and the AI has spoken.${cacheNote}\nThey are now known as: **${nickname}**`,
                    }),
                catch: () => new DiscordFetchError({ reason: "Failed to edit reply." }),
            });
        });

        await Effect.runPromise(
            program.pipe(
                Effect.provide(AppLayer),
                Effect.catchAll((err) =>
                    Effect.tryPromise({
                        try: () => {
                            const msg =
                                err._tag === "MissingApiKeyError"
                                    ? "OPENROUTER_API_KEY is not configured."
                                    : err._tag === "OpenRouterError"
                                        ? `OpenRouter error ${err.status}: ${err.body}`
                                        : err._tag === "NicknameSetError"
                                            ? `Could not set nickname: ${err.reason}`
                                            : err._tag === "CooldownError"
                                                ? `The command is on cooldown. Try again in **${Math.ceil(err.remainingMs / 1000)}s**.`
                                                : err._tag === "DbError"
                                                    ? `Database error: ${err.message}`
                                                    : err.reason;
                            return interaction.editReply({ content: `❌ ${msg}` });
                        },
                        catch: () => void 0,
                    }),
                ),
            ),
        );
    }
}
