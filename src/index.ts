import "dotenv/config";
import "@sapphire/plugin-editable-commands/register";
import { SapphireClient, LogLevel, ApplicationCommandRegistries, RegisterBehavior } from "@sapphire/framework";
import { GatewayIntentBits, Partials } from "discord.js";
import { Layer } from "effect";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { DbLive } from "./lib/db.js";
import { RedisLive } from "./lib/redis.js";
import { redditScheduler } from "./lib/reddit-scheduler.js";

ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

export const AppLayer = Layer.mergeAll(DbLive, RedisLive);

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new SapphireClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    defaultPrefix: "b!",
    logger: { level: LogLevel.Info },
    loadMessageCommandListeners: true,
    baseUserDirectory: join(__dirname),
});

async function shutdown() {
    console.log("Shutting down...");
    redditScheduler.stop();
    await client.destroy();
    process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await client.login(process.env.DISCORD_TOKEN);
