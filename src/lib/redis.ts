import { Redis } from "@upstash/redis";
import { Context, Data, Effect, Layer } from "effect";

export class RedisError extends Data.TaggedError("RedisError")<{
    readonly message: string;
}> { }

export class RedisClient extends Context.Tag("RedisClient")<RedisClient, Redis>() { }

export const RedisLive = Layer.effect(
    RedisClient,
    Effect.try({
        try: () =>
            new Redis({
                url: process.env.UPSTASH_REDIS_REST_URL!,
                token: process.env.UPSTASH_REDIS_REST_TOKEN!,
            }),
        catch: (err) => new RedisError({ message: `Failed to create Redis client: ${err}` }),
    })
);
