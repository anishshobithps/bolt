import "dotenv/config";
import { SapphireClient, LogLevel, ApplicationCommandRegistries, RegisterBehavior } from "@sapphire/framework";
import { GatewayIntentBits, Partials } from "discord.js";
import { Layer } from "effect";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { DbLive } from "./lib/db.js";

ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

const guildId = process.env.GUILD_ID;

export const AppLayer = Layer.mergeAll(DbLive);
export { guildId };

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new SapphireClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    logger: { level: LogLevel.Info },
    loadMessageCommandListeners: true,
    baseUserDirectory: join(__dirname),
});

await client.login(process.env.DISCORD_TOKEN);
