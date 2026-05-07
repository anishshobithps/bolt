import { Args, Command } from "@sapphire/framework";
import { send } from "@sapphire/plugin-editable-commands";
import { Stopwatch } from "@sapphire/stopwatch";
import { codeBlock, type Message } from "discord.js";
import { inspect } from "node:util";

const MAX_OUTPUT_LENGTH = 1900;

function redactSecrets(str: string): string {
    for (const [key, value] of Object.entries(process.env)) {
        if (value && value.length >= 8) {
            str = str.split(value).join(`[REDACTED:${key}]`);
        }
    }
    return str;
}

function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    const overflow = str.length - max;
    return `${str.slice(0, max)}\n… (${overflow} more characters)`;
}

/** Strip surrounding triple-backtick code block markers if present. */
function cleanCode(raw: string): string {
    const match = raw.match(/^```(?:\w+\n)?([\s\S]+?)```$/);
    return match?.[1]?.trim() ?? raw;
}

export class EvalCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, {
            ...options,
            name: "eval",
            preconditions: ["OwnerOnly"],
            // Parsed as boolean flags: --async / -a
            flags: ["async", "a"],
            // Parsed as value options: --depth=N / -d N
            options: ["depth", "d"],
        });
    }

    public override async messageRun(message: Message, args: Args) {
        const isAsync = args.getFlags("async", "a");
        const depthStr = args.getOption("depth", "d");
        const depth = depthStr ? Math.min(10, Math.max(0, Number.parseInt(depthStr, 10))) : 2;

        const raw = await args.rest("string").catch(() => null);
        if (!raw) return send(message, "❌ Please provide code to evaluate.");

        const code = cleanCode(raw);

        // Expose useful references inside the eval scope via closure
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const client = this.container.client;
        const { container } = this;
        const guild = message.guild;
        const channel = message.channel;
        /* eslint-enable @typescript-eslint/no-unused-vars */

        const stopwatch = new Stopwatch();
        let result: unknown;
        let success = true;
        let typeName = "void";

        try {
            const toEval = isAsync ? `(async () => {\n${code}\n})()` : code;
            // biome-ignore lint/security/noEval: intentional eval command for bot owner
            result = eval(toEval); // eslint-disable-line no-eval

            if (result instanceof Promise) result = await result;

            stopwatch.stop();
            typeName = getType(result);
            success = true;
        } catch (error) {
            stopwatch.stop();
            result = error instanceof Error ? (error.stack ?? error.message) : String(error);
            typeName = "error";
            success = false;
        }

        let output: string;
        if (typeof result === "string") {
            output = result;
        } else {
            output = inspect(result, { depth, colors: false });
        }

        output = redactSecrets(output);
        output = truncate(output, MAX_OUTPUT_LENGTH);

        const statusIcon = success ? "✅" : "❌";
        const content = [
            `${statusIcon} **Type:** \`${typeName}\` | **Time:** \`${stopwatch}\``,
            codeBlock("js", output),
        ].join("\n");

        return send(message, content);
    }
}

function getType(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return `Array<${(value as unknown[]).length}>`;
    if (value instanceof Promise) return "Promise";
    if (value instanceof Map) return `Map<${(value as Map<unknown, unknown>).size}>`;
    if (value instanceof Set) return `Set<${(value as Set<unknown>).size}>`;
    if (value instanceof Error) return value.constructor.name;
    if (typeof value === "object") return value.constructor?.name ?? "Object";
    return typeof value;
}
