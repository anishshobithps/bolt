import { Listener, Events } from "@sapphire/framework";
import { type Message } from "discord.js";
import { Data, Effect } from "effect";

const MODEL = "perplexity/sonar-pro";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_HISTORY = 10;
const MSG_LIMIT = 2000;
const LONG_TOTAL_LIMIT = 5000;

const LONG_TRIGGER =
    /\b(detail|detailed|explain|elaborate|full|long|thorough|comprehensive|in[\s-]depth|step[\s-]by[\s-]step|more info|tell me more|expand)\b/i;

const RESET_TRIGGER =
    /^(reset|forget|clear|wipe)\s*(my\s*)?(memory|history|chat|context|conversation)?[.!?]*$/i;

const SHORT_SYSTEM =
    "You are Bolt, a helpful Discord bot assistant with real-time web search (Wikipedia, news, general knowledge).\n" +
    "Keep your answer under 1800 characters. Be concise but accurate.\n" +
    "Use Discord markdown: **bold**, *italic*, `inline code`, ```language\ncode blocks\n```, ## headers, - lists, > blockquotes.\n" +
    "Do NOT write source links or citation sections \u2014 they are appended automatically.";

const LONG_SYSTEM =
    "You are Bolt, a helpful Discord bot assistant with real-time web search (Wikipedia, news, general knowledge).\n" +
    "The user wants a detailed answer \u2014 you may use up to 4800 characters.\n" +
    "Structure your response with ## headers and clear paragraph breaks so it splits cleanly.\n" +
    "Always close every code block with ``` before a paragraph break \u2014 never leave a code block unclosed at a split point.\n" +
    "Use Discord markdown: **bold**, *italic*, `inline code`, ```language\ncode blocks\n```, ## headers, - lists, > blockquotes.\n" +
    "Do NOT write source links or citation sections \u2014 they are appended automatically.";

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

const userHistory = new Map<string, ChatMessage[]>();

function historyKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
}

function getHistory(guildId: string, userId: string): ChatMessage[] {
    const key = historyKey(guildId, userId);
    if (!userHistory.has(key)) userHistory.set(key, []);
    return userHistory.get(key)!;
}

function pushToHistory(guildId: string, userId: string, msg: ChatMessage): void {
    const history = getHistory(guildId, userId);
    history.push(msg);
    while (history.length > MAX_HISTORY) history.shift();
}

function clearHistory(guildId: string, userId: string): void {
    userHistory.delete(historyKey(guildId, userId));
}

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

const callOpenRouter = (history: ChatMessage[], isLong: boolean) =>
    Effect.gen(function* () {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return yield* Effect.fail(new MentionApiError({ message: "OPENROUTER_API_KEY is not set." }));

        const messages: ChatMessage[] = [
            { role: "system", content: isLong ? LONG_SYSTEM : SHORT_SYSTEM },
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
                        model: MODEL,
                        messages,
                        max_tokens: isLong ? 2048 : 600,
                        temperature: 0.7,
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

        if (RESET_TRIGGER.test(rawQuery)) {
            clearHistory(guildId, userId);
            await message.reply({ content: "Memory cleared \u2014 starting fresh!", allowedMentions: { repliedUser: true } });
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
            await message.reply("Hey! Ask me anything \u2014 I can search the web, look up Wikipedia, and more.");
            return;
        }

        await channel.sendTyping().catch(() => null);

        const isLong = LONG_TRIGGER.test(query);

        pushToHistory(guildId, userId, {
            role: "user",
            content: `${message.author.displayName}: ${query}`,
        });

        const result = await Effect.runPromise(
            callOpenRouter(getHistory(guildId, userId), isLong).pipe(
                Effect.catchAll((err) =>
                    Effect.succeed({ content: `\u26a0\ufe0f ${err.message}`, citations: [] as string[] })
                )
            )
        );

        const sources = formatSources(result.citations);
        const body = isLong
            ? result.content.slice(0, LONG_TOTAL_LIMIT - sources.length)
            : result.content.slice(0, MSG_LIMIT - sources.length - 1);

        pushToHistory(guildId, userId, { role: "assistant", content: body });

        const noMentions = { repliedUser: true, users: [] };

        if (!isLong || body.length + sources.length <= MSG_LIMIT) {
            await message.reply({
                content: body + sources,
                allowedMentions: noMentions,
            });
            return;
        }

        const chunks = smartSplit(body);
        const [first, ...rest] = chunks;

        if (first) {
            await message.reply({
                content: first,
                allowedMentions: noMentions,
            });
        }

        for (let i = 0; i < rest.length; i++) {
            const isLast = i === rest.length - 1;
            await channel.send({ content: isLast ? rest[i]! + sources : rest[i]!, allowedMentions: { users: [] } });
        }

        if (chunks.length === 1 && sources) {
            await channel.send({ content: sources.trimStart(), allowedMentions: { users: [] } });
        }
    }
}
