import { describe, expect, it } from "vitest";
import type { LearningSignalClass } from "./learning-event.js";
import type { TrajectorySignalClass } from "@mendpoint/db";

// The learning layer mirrors the observation layer's precedence vocabulary
// (`TrajectorySignalClass` in packages/db/src/trajectory.ts) as a local union so
// this schema module stays dependency-free. This is a compile-time tripwire: if
// either union gains or loses a member the equality collapses to `false`,
// `AssertTrue<false>` stops typechecking, and `npm run typecheck` fails here —
// forcing both unions (and the runtime tripwire below) to be reconciled together.
type AssertTrue<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _SignalClassesInSync = AssertTrue<Equal<LearningSignalClass, TrajectorySignalClass>>;

describe("learning signal class stays in sync with the trajectory signal class", () => {
  it("enumerates exactly the same members as the observation layer", () => {
    const learning = new Set<LearningSignalClass>(["hard", "soft"]);
    const trajectory = new Set<TrajectorySignalClass>(["hard", "soft"]);
    expect(learning).toEqual(trajectory);
  });
});
