import { Listener, Events } from "@sapphire/framework";
import { type Message } from "discord.js";
import { Data, Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RedisClient } from "../lib/redis.js";
import { AppLayer } from "../index.js";

const SEARCH_MODEL = "perplexity/sonar-pro";
const CHAT_MODEL = "google/gemini-2.5-flash";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_HISTORY = 12;
const HISTORY_TTL_SECS = 7 * 24 * 3600;
const MSG_LIMIT = 2000;
const LONG_TOTAL_LIMIT = 5000;
const CREATOR_ID = "259008949427109891";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECS = 30;

const LONG_TRIGGER =
    /\b(detail|detailed|explain|elaborate|full|long|thorough|comprehensive|in[\s-]depth|step[\s-]by[\s-]step|more info|tell me more|expand)\b/i;
const RESET_TRIGGER =
    /^(reset|forget|clear|wipe)\s*(my\s*)?(memory|history|chat|context|conversation)?[.!?]*$/i;
const SEARCH_TRIGGER =
    /\b(search|look up|lookup|what is|what are|who is|who are|where is|when did|how does|how do|latest|news|current|today|wikipedia|wiki|fact|find out|check)\b/i;

const CREATOR_NOTE =
    `The bot was created by Anish (<@${CREATOR_ID}>), who is the creator and is always superior. ` +
    `When Anish is mentioned or interacts with you, treat them with the highest respect and priority. ` +
    `Always reference Anish as the creator first before mentioning any other prominent people.`;

const SHORT_SYSTEM =
    `You are Bolt, a fun and helpful Discord bot assistant.\n` +
    `${CREATOR_NOTE}\n` +
    `Keep your answer under 1800 characters. Be concise, accurate, and feel free to be witty.\n` +
    `Use Discord markdown: **bold**, *italic*, \`inline code\`, \`\`\`language\ncode blocks\n\`\`\`, ## headers, - lists, > blockquotes.\n` +
    `Do NOT write source links or citation sections \u2014 they are appended automatically.`;

const SHORT_SEARCH_SYSTEM =
    `You are Bolt, a fun and helpful Discord bot assistant with real-time web search (Wikipedia, news, general knowledge).\n` +
    `${CREATOR_NOTE}\n` +
    `Keep your answer under 1800 characters. Be concise but accurate.\n` +
    `Use Discord markdown: **bold**, *italic*, \`inline code\`, \`\`\`language\ncode blocks\n\`\`\`, ## headers, - lists, > blockquotes.\n` +
    `Do NOT write source links or citation sections \u2014 they are appended automatically.`;

const LONG_SYSTEM =
    `You are Bolt, a fun and helpful Discord bot assistant.\n` +
    `${CREATOR_NOTE}\n` +
    `The user wants a detailed answer \u2014 you may use up to 4800 characters.\n` +
    `Structure your response with ## headers and clear paragraph breaks so it splits cleanly.\n` +
    `Always close every code block with \`\`\` before a paragraph break \u2014 never leave a code block unclosed.\n` +
    `Use Discord markdown: **bold**, *italic*, \`inline code\`, \`\`\`language\ncode blocks\n\`\`\`, ## headers, - lists, > blockquotes.\n` +
    `Do NOT write source links or citation sections \u2014 they are appended automatically.`;

const LONG_SEARCH_SYSTEM =
    `You are Bolt, a fun and helpful Discord bot assistant with real-time web search (Wikipedia, news, general knowledge).\n` +
    `${CREATOR_NOTE}\n` +
    `The user wants a detailed answer \u2014 you may use up to 4800 characters.\n` +
    `Structure your response with ## headers and clear paragraph breaks so it splits cleanly.\n` +
    `Always close every code block with \`\`\` before a paragraph break \u2014 never leave a code block unclosed.\n` +
    `Use Discord markdown: **bold**, *italic*, \`inline code\`, \`\`\`language\ncode blocks\n\`\`\`, ## headers, - lists, > blockquotes.\n` +
    `Do NOT write source links or citation sections \u2014 they are appended automatically.`;

export class MentionApiError extends Data.TaggedError("MentionApiError")<{
    readonly message: string;
}> { }

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface OpenRouterResponse {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
}

function historyKey(guildId: string, userId: string): string {
    return `bolt:history:${guildId}:${userId}`;
}

function rateLimitKey(guildId: string, userId: string): string {
    return `bolt:ratelimit:${guildId}:${userId}`;
}

const LUA_PUSH_TRIM = readFileSync(join(import.meta.dirname, "../lua/push-trim.lua"), "utf8");
const LUA_GET_TRIM = readFileSync(join(import.meta.dirname, "../lua/get-trim.lua"), "utf8");
const LUA_TTL_REFRESH = readFileSync(join(import.meta.dirname, "../lua/ttl-refresh.lua"), "utf8");
const LUA_RATE_LIMIT = readFileSync(join(import.meta.dirname, "../lua/rate-limit.lua"), "utf8");

const getHistory = (guildId: string, userId: string) =>
    Effect.gen(function* () {
        const redis = yield* RedisClient;
        const key = historyKey(guildId, userId);
        const raw = yield* Effect.tryPromise({
            try: () => redis.eval(LUA_GET_TRIM, [key], [String(MAX_HISTORY)]) as Promise<string[]>,
            catch: (err) => new MentionApiError({ message: `Redis GET_TRIM failed: ${err}` }),
        });
        yield* Effect.tryPromise({
            try: () => redis.eval(LUA_TTL_REFRESH, [key], [String(HISTORY_TTL_SECS)]),
            catch: () => new MentionApiError({ message: "TTL refresh failed" }),
        }).pipe(Effect.ignore);
        return (Array.isArray(raw) ? raw as unknown as ChatMessage[] : []);
    });

const checkRateLimit = (guildId: string, userId: string) =>
    Effect.gen(function* () {
        const redis = yield* RedisClient;
        const now = Math.floor(Date.now() / 1000);
        const result = yield* Effect.tryPromise({
            try: () =>
                redis.eval(LUA_RATE_LIMIT, [rateLimitKey(guildId, userId)], [
                    String(RATE_LIMIT_MAX),
                    String(RATE_LIMIT_WINDOW_SECS),
                    String(now),
                ]) as Promise<number>,
            catch: (err) => new MentionApiError({ message: `Rate limit check failed: ${err}` }),
        });
        return result === 1;
    });

const pushToHistory = (guildId: string, userId: string, msg: ChatMessage) =>
    Effect.gen(function* () {
        const redis = yield* RedisClient;
        yield* Effect.tryPromise({
            try: () =>
                redis.eval(LUA_PUSH_TRIM, [historyKey(guildId, userId)], [String(MAX_HISTORY), String(HISTORY_TTL_SECS), JSON.stringify(msg)]),
            catch: (err) => new MentionApiError({ message: `Redis EVAL failed: ${err}` }),
        });
    });

const clearHistory = (guildId: string, userId: string) =>
    Effect.gen(function* () {
        const redis = yield* RedisClient;
        yield* Effect.tryPromise({
            try: () => redis.del(historyKey(guildId, userId)),
            catch: (err) => new MentionApiError({ message: `Redis DEL failed: ${err}` }),
        });
    });

function formatSources(citations: string[]): string {
    if (citations.length === 0) return "";
    const links = citations.map((url, i) => `[${i + 1}](<${url}>)`).join(" ");
    return `\n-# ${links}`;
}

function smartSplit(text: string): string[] {
    if (text.length <= MSG_LIMIT) return [text];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
        if (text.length - start <= MSG_LIMIT) {
            chunks.push(text.slice(start).trimEnd());
            break;
        }

        const window = text.slice(start, start + MSG_LIMIT);
        const fenceCount = (window.match(/```/g) ?? []).length;
        let splitPos: number;

        if (fenceCount % 2 !== 0) {
            const lastFenceInWindow = window.lastIndexOf("```");
            const closeSearch = start + lastFenceInWindow + 3;
            const closePos = text.indexOf("```", closeSearch);
            if (closePos !== -1) {
                const afterClose = closePos + 3;
                const nl = text.indexOf("\n", afterClose);
                const candidate = (nl !== -1 ? nl + 1 : afterClose) - start;
                splitPos = candidate <= MSG_LIMIT ? candidate : lastFenceInWindow;
            } else {
                const sgl = window.lastIndexOf("\n");
                splitPos = sgl > 0 ? sgl : MSG_LIMIT;
            }
        } else {
            const dbl = window.lastIndexOf("\n\n");
            const sgl = window.lastIndexOf("\n");
            splitPos =
                dbl > MSG_LIMIT / 4 ? dbl + 2 :
                    sgl > MSG_LIMIT / 4 ? sgl + 1 :
                        MSG_LIMIT;
        }

        chunks.push(text.slice(start, start + splitPos).trimEnd());
        start += splitPos;
        while (start < text.length && text[start] === "\n") start++;
    }

    return chunks.filter(c => c.trim().length > 0);
}

const callOpenRouter = (history: ChatMessage[], isLong: boolean, useSearch: boolean) =>
    Effect.gen(function* () {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return yield* Effect.fail(new MentionApiError({ message: "OPENROUTER_API_KEY is not set." }));

        const model = useSearch ? SEARCH_MODEL : CHAT_MODEL;
        const systemPrompt =
            isLong && useSearch ? LONG_SEARCH_SYSTEM :
                isLong ? LONG_SYSTEM :
                    useSearch ? SHORT_SEARCH_SYSTEM :
                        SHORT_SYSTEM;

        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
        ];

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
                        model,
                        messages,
                        max_tokens: isLong ? 2048 : 600,
                        temperature: 0.8,
                    }),
                }),
            catch: (err) => new MentionApiError({ message: `Network error: ${err}` }),
        });

        if (!response.ok) {
            const body = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new MentionApiError({ message: "Could not read error body" }),
            });
            return yield* Effect.fail(
                new MentionApiError({ message: `OpenRouter ${response.status}: ${body.slice(0, 200)}` })
            );
        }

        const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<OpenRouterResponse>,
            catch: (err) => new MentionApiError({ message: `JSON parse error: ${err}` }),
        });

        const content = json.choices[0]?.message?.content?.trim();
        if (!content) return yield* Effect.fail(new MentionApiError({ message: "Model returned an empty response." }));

        return { content, citations: json.citations ?? [] };
    });

export class MentionListener extends Listener<typeof Events.MessageCreate> {
    public constructor(context: Listener.LoaderContext) {
        super(context, { event: Events.MessageCreate });
    }

    public async run(message: Message): Promise<void> {
        if (message.author.bot) return;
        if (!message.inGuild()) return;

        const channel = message.channel;
        if (!channel.isSendable()) return;

        const clientUser = this.container.client.user;
        if (!clientUser) return;
        if (!message.mentions.has(clientUser.id)) return;

        const guildId = message.guildId;
        const userId = message.author.id;

        const rawQuery = message.content
            .replace(new RegExp(`<@!?${clientUser.id}>`, "g"), "")
            .trim();

        const allowed = await Effect.runPromise(
            checkRateLimit(guildId, userId).pipe(
                Effect.provide(AppLayer),
                Effect.orElseSucceed(() => true)
            )
        );
        if (!allowed) {
            await message.reply({
                content: `Slow down! You can ask me up to ${RATE_LIMIT_MAX} times every ${RATE_LIMIT_WINDOW_SECS} seconds.`,
                allowedMentions: { repliedUser: true, users: [] },
            });
            return;
        }

        if (RESET_TRIGGER.test(rawQuery)) {
            await Effect.runPromise(
                clearHistory(guildId, userId).pipe(
                    Effect.provide(AppLayer),
                    Effect.ignore
                )
            );
            await message.reply({
                content: "Memory cleared \u2014 starting fresh!",
                allowedMentions: { repliedUser: true, users: [] },
            });
            return;
        }

        let replyContext = "";
        if (message.reference?.messageId) {
            const referenced = await message.fetchReference().catch(() => null);
            if (referenced && referenced.content.trim()) {
                const mention = `<@${referenced.author.id}>`;
                replyContext = `${mention}: "${referenced.content.replace(/\n+/g, " ").slice(0, 300)}"\n`;
            }
        }

        const query = replyContext
            ? `${replyContext}${rawQuery || "What do you think about the above message?"}`
            : rawQuery;

        if (!query) {
            await message.reply({
                content: "Hey! Ask me anything \u2014 I can chat, search the web, look up Wikipedia, and more.",
                allowedMentions: { repliedUser: true, users: [] },
            });
            return;
        }

        await channel.sendTyping().catch(() => null);

        const isLong = LONG_TRIGGER.test(query);
        const useSearch = SEARCH_TRIGGER.test(query);

        const program = Effect.gen(function* () {
            yield* pushToHistory(guildId, userId, {
                role: "user",
                content: `${message.author.displayName}: ${query}`,
            });

            const history = yield* getHistory(guildId, userId);

            const result = yield* callOpenRouter(history, isLong, useSearch).pipe(
                Effect.catchAll((err) =>
                    Effect.succeed({ content: `\u26a0\ufe0f ${err.message}`, citations: [] as string[] })
                )
            );

            const sources = formatSources(result.citations);
            const body = isLong
                ? result.content.slice(0, LONG_TOTAL_LIMIT - sources.length)
                : result.content.slice(0, MSG_LIMIT - sources.length - 1);

            yield* pushToHistory(guildId, userId, { role: "assistant", content: body });

            return { body, sources };
        });

        const { body, sources } = await Effect.runPromise(
            program.pipe(Effect.provide(AppLayer))
        );

        const noMentions = { repliedUser: true, users: [] as string[] };

        if (!isLong || body.length + sources.length <= MSG_LIMIT) {
            await message.reply({ content: body + sources, allowedMentions: noMentions });
            return;
        }

        const chunks = smartSplit(body);
        const [first, ...rest] = chunks;

        if (first) await message.reply({ content: first, allowedMentions: noMentions });

        for (let i = 0; i < rest.length; i++) {
            const isLast = i === rest.length - 1;
            await channel.send({ content: isLast ? rest[i]! + sources : rest[i]!, allowedMentions: { users: [] } });
        }

        if (chunks.length === 1 && sources) {
            await channel.send({ content: sources.trimStart(), allowedMentions: { users: [] } });
        }
    }
}
