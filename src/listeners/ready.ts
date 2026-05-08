import { Listener, Events, container } from "@sapphire/framework";
import type { Client } from "discord.js";
import { Effect } from "effect";
import { initDb, initRedditDb } from "../lib/db.js";
import { AppLayer } from "../index.js";
import { redditScheduler } from "../lib/reddit-scheduler.js";

export class ReadyListener extends Listener<typeof Events.ClientReady> {
    public constructor(context: Listener.LoaderContext) {
        super(context, { event: Events.ClientReady, once: true });
    }

    public async run(client: Client<true>) {
        await Effect.runPromise(initDb.pipe(Effect.provide(AppLayer)));
        await Effect.runPromise(initRedditDb.pipe(Effect.provide(AppLayer)));
        redditScheduler.start(client);
        await Promise.all(client.guilds.cache.map((guild) => guild.members.fetch()));
        container.logger.info(`Online as ${client.user.tag}`);
    }
}
