import { Schema } from "effect";
import type { RedditFeedWithGroup } from "./db.js";

export const RotationAlgorithmSchema = Schema.Literal(
    "weighted-random",
    "round-robin",
    "least-recent",
    "strict-priority"
);
export type RotationAlgorithm = Schema.Schema.Type<typeof RotationAlgorithmSchema>;

export const ROTATION_ALGORITHM_CHOICES = [
    { name: "Weighted Random — feeds chosen by weight, randomly sampled", value: "weighted-random" },
    { name: "Round Robin — cycles through feeds alphabetically, ignores weight", value: "round-robin" },
    { name: "Least Recent — always picks the feed posted from longest ago", value: "least-recent" },
    { name: "Strict Priority — highest-weight feed always wins, ties broken by least recent", value: "strict-priority" },
] as const;

export class RotationSelector {
    private readonly roundRobinState = new Map<number, string>();

    select(
        groupId: number,
        due: RedditFeedWithGroup[],
        algorithm: RotationAlgorithm
    ): RedditFeedWithGroup | undefined {
        if (due.length === 0) return undefined;
        switch (algorithm) {
            case "weighted-random": return this.weightedRandom(due);
            case "round-robin": return this.roundRobin(groupId, due);
            case "least-recent": return this.leastRecent(due);
            case "strict-priority": return this.strictPriority(due);
        }
    }

    private weightedRandom(due: RedditFeedWithGroup[]): RedditFeedWithGroup {
        const total = due.reduce((sum, f) => sum + f.weight, 0);
        let rand = Math.random() * total;
        for (const f of due) {
            rand -= f.weight;
            if (rand <= 0) return f;
        }
        return due[due.length - 1]!;
    }

    private roundRobin(groupId: number, due: RedditFeedWithGroup[]): RedditFeedWithGroup {
        const sorted = [...due].sort((a, b) => a.subreddit.localeCompare(b.subreddit));
        const last = this.roundRobinState.get(groupId);
        const lastIdx = last ? sorted.findIndex((f) => f.subreddit === last) : -1;
        const pick = sorted[(lastIdx + 1) % sorted.length]!;
        this.roundRobinState.set(groupId, pick.subreddit);
        return pick;
    }

    private leastRecent(due: RedditFeedWithGroup[]): RedditFeedWithGroup {
        return due.reduce((oldest, f) =>
            f.lastCheckedAt < oldest.lastCheckedAt ? f : oldest, due[0]!
        );
    }

    private strictPriority(due: RedditFeedWithGroup[]): RedditFeedWithGroup {
        const maxWeight = Math.max(...due.map((f) => f.weight));
        const top = due.filter((f) => f.weight === maxWeight);
        return this.leastRecent(top);
    }
}

export const rotationSelector = new RotationSelector();
