import { Command } from "@sapphire/framework";
import { Stopwatch } from "@sapphire/stopwatch";
import { codeBlock, MessageFlags } from "discord.js";
import { inspect } from "node:util";

const MAX_OUTPUT_LENGTH = 1900;

/**
 * Replaces any process.env value that appears in the output string with a
 * redaction placeholder, preventing accidental token or secret leakage.
 */
function redactSecrets(str: string): string {
    for (const [key, value] of Object.entries(process.env)) {
        if (value && value.length >= 8) {
            // Use a global literal replacement without regex to avoid ReDoS
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

export class EvalCommand extends Command {
    public constructor(context: Command.LoaderContext, options: Command.Options) {
        super(context, { ...options, name: "eval", preconditions: ["OwnerOnly"] });
    }

    public override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand(
            (builder) =>
                builder
                    .setName("eval")
                    .setDescription("Evaluate JavaScript/TypeScript code (bot owner only)")
                    .addStringOption((opt) =>
                        opt
                            .setName("code")
                            .setDescription("The code to evaluate")
                            .setRequired(true)
                    )
                    .addIntegerOption((opt) =>
                        opt
                            .setName("depth")
                            .setDescription("util.inspect depth for objects (default: 2, max: 10)")
                            .setMinValue(0)
                            .setMaxValue(10)
                            .setRequired(false)
                    )
                    .addBooleanOption((opt) =>
                        opt
                            .setName("async")
                            .setDescription(
                                "Wrap code in an async IIFE so you can use top-level await (default: false)"
                            )
                            .setRequired(false)
                    )
                    .addBooleanOption((opt) =>
                        opt
                            .setName("silent")
                            .setDescription("Reply ephemerally so only you can see the output (default: true)")
                            .setRequired(false)
                    ),
            { idHints: [] }
        );
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        const code = interaction.options.getString("code", true);
        const depth = interaction.options.getInteger("depth") ?? 2;
        const isAsync = interaction.options.getBoolean("async") ?? false;
        const silent = interaction.options.getBoolean("silent") ?? true;

        await interaction.deferReply({ flags: silent ? MessageFlags.Ephemeral : undefined });

        // Expose useful references inside the eval scope via closure
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const client = this.container.client;
        const { container } = this;
        const guild = interaction.guild;
        const channel = interaction.channel;
        /* eslint-enable @typescript-eslint/no-unused-vars */

        const stopwatch = new Stopwatch();
        let result: unknown;
        let success = true;
        let typeName = "void";

        try {
            const toEval = isAsync ? `(async () => {\n${code}\n})()` : code;
            // Direct eval — intentional developer tool, access already gated by OwnerOnly precondition
            // biome-ignore lint/security/noEval: intentional eval command for bot owner
            result = eval(toEval); // eslint-disable-line no-eval

            if (result instanceof Promise) {
                result = await result;
            }

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
            output = inspect(result, { depth, colors: false, maxArrayLength: 50, breakLength: 80 });
        }

        output = redactSecrets(output);
        output = truncate(output, MAX_OUTPUT_LENGTH);

        const statusIcon = success ? "✅" : "❌";
        const content = [
            `${statusIcon} **Type:** \`${typeName}\` | **Time:** \`${stopwatch}\``,
            codeBlock("js", output),
        ].join("\n");

        return interaction.editReply({ content });
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
