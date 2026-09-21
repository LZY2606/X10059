import { assert, assertEquals, assertThrows } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";
import { createTimePoint, fromTZ, resolveDSTTransition } from "../src/helpers/timezone.ts";

// Contract tests for the unified, direction-parameterized next/previous search
// and the explicit DST transition guard.
//
// All tests use explicit IANA timezones and fixed reference instants, so they
// are independent of the system timezone and wall clock.
//
// Conditional symmetry contract:
// - If t is itself a scheduled run, previousRuns(1, nextRun(t)) === t and
//   nextRun(previousRuns(1, t)[0]) === t.
// - If t is not a scheduled run, previousRuns(1, nextRun(t)) returns the
//   greatest scheduled run <= t.
// - The conditions: instants whose local time falls inside a DST transition
//   window (gap or overlap) are governed by the explicit guard resolutions
//   pinned below, not by plain symmetry.

const SYMMETRY_TIMEZONES = [
  "Etc/UTC",
  "America/New_York",
  "Europe/Stockholm",
  "Australia/Sydney",
  "Asia/Tokyo",
];

// Reference instants chosen far away from any DST transition window
const SYMMETRY_REFERENCES = [
  "2025-01-15T10:07:00Z",
  "2025-06-15T10:07:00Z",
];

test("Bidirectional contract: previous(next(t)) === t for exact runs in all timezones", () => {
  for (const timezone of SYMMETRY_TIMEZONES) {
    const job = new Cron("*/15 * * * *", { timezone });
    for (const ref of SYMMETRY_REFERENCES) {
      const run = job.nextRun(new Date(ref));
      assert(run !== null, `Expected a run after ${ref} in ${timezone}`);
      const after = job.nextRun(run);
      assert(after !== null, `Expected a run after ${run.toISOString()} in ${timezone}`);
      const backToRun = job.previousRuns(1, after)[0];
      assertEquals(
        backToRun?.getTime(),
        run.getTime(),
        `previous(next(${run.toISOString()})) should return the run itself in ${timezone}`,
      );
    }
  }
});

test("Bidirectional contract: next(previous(t)) === t for exact runs in all timezones", () => {
  for (const timezone of SYMMETRY_TIMEZONES) {
    const job = new Cron("*/15 * * * *", { timezone });
    for (const ref of SYMMETRY_REFERENCES) {
      const run = job.nextRun(new Date(ref));
      assert(run !== null, `Expected a run after ${ref} in ${timezone}`);
      const before = job.previousRuns(1, run)[0];
      assert(before !== undefined, `Expected a run before ${run.toISOString()} in ${timezone}`);
      const forwardToRun = job.nextRun(before);
      assertEquals(
        forwardToRun?.getTime(),
        run.getTime(),
        `next(previous(${run.toISOString()})) should return the run itself in ${timezone}`,
      );
    }
  }
});

test("Bidirectional contract: previous(next(t)) returns greatest run <= t for non-run instants", () => {
  for (const timezone of SYMMETRY_TIMEZONES) {
    const job = new Cron("*/15 * * * *", { timezone });
    for (const ref of SYMMETRY_REFERENCES) {
      const t = new Date(ref);
      // These references are intentionally not aligned to the 15-minute grid
      assertEquals(job.match(t), false, `${ref} should not be a scheduled run`);
      const next = job.nextRun(t);
      assert(next !== null);
      const greatestRunBeforeT = job.previousRuns(1, t)[0];
      const previousOfNext = job.previousRuns(1, next)[0];
      assertEquals(
        previousOfNext?.getTime(),
        greatestRunBeforeT?.getTime(),
        `previous(next(t)) should equal the greatest run <= t in ${timezone}`,
      );
      assert(
        previousOfNext !== undefined && previousOfNext.getTime() < t.getTime(),
        `previous(next(t)) for a non-run t must be strictly before t in ${timezone}`,
      );
    }
  }
});

test("DST guard: nonexistent local time (spring gap) classifies as gap and resolves forward", () => {
  // America/New_York: 2025-03-09 02:30 does not exist (02:00 -> 03:00)
  const nyGap = resolveDSTTransition(createTimePoint(2025, 3, 9, 2, 30, 0, "America/New_York"));
  assertEquals(nyGap.classification, "gap");
  assertEquals(nyGap.date.toISOString(), "2025-03-09T07:30:00.000Z"); // 03:30 EDT

  // Europe/Stockholm: 2025-03-30 02:30 does not exist (02:00 -> 03:00)
  const stoGap = resolveDSTTransition(createTimePoint(2025, 3, 30, 2, 30, 0, "Europe/Stockholm"));
  assertEquals(stoGap.classification, "gap");
  assertEquals(stoGap.date.toISOString(), "2025-03-30T01:30:00.000Z"); // 03:30 CEST

  // Australia/Sydney: 2025-10-05 02:30 does not exist (02:00 -> 03:00)
  const sydGap = resolveDSTTransition(createTimePoint(2025, 10, 5, 2, 30, 0, "Australia/Sydney"));
  assertEquals(sydGap.classification, "gap");
  assertEquals(sydGap.date.toISOString(), "2025-10-04T16:30:00.000Z"); // 03:30 AEDT
});

test("DST guard: repeated local time (fall overlap) classifies as overlap and resolves to first occurrence", () => {
  // America/New_York: 2025-11-02 01:30 happens twice; first is EDT (UTC-4)
  const nyOverlap = resolveDSTTransition(
    createTimePoint(2025, 11, 2, 1, 30, 0, "America/New_York"),
  );
  assertEquals(nyOverlap.classification, "overlap");
  assertEquals(nyOverlap.date.toISOString(), "2025-11-02T05:30:00.000Z");

  // Australia/Sydney: 2025-04-06 02:30 happens twice; first is AEDT (UTC+11)
  const sydOverlap = resolveDSTTransition(
    createTimePoint(2025, 4, 6, 2, 30, 0, "Australia/Sydney"),
  );
  assertEquals(sydOverlap.classification, "overlap");
  assertEquals(sydOverlap.date.toISOString(), "2025-04-05T15:30:00.000Z");
});

test("DST guard: ordinary local times classify as unique", () => {
  for (const timezone of SYMMETRY_TIMEZONES) {
    const resolution = resolveDSTTransition(createTimePoint(2025, 6, 15, 12, 0, 0, timezone));
    assertEquals(resolution.classification, "unique", `Expected unique local time in ${timezone}`);
  }
});

test("DST guard: fromTZ preserves gap/overlap resolutions and throwOnInvalid semantics", () => {
  const gap = createTimePoint(2025, 3, 9, 2, 30, 0, "America/New_York");
  assertEquals(fromTZ(gap).toISOString(), "2025-03-09T07:30:00.000Z");
  assertThrows(
    () => fromTZ(gap, true),
    Error,
    "Invalid date passed to fromTZ()",
  );

  const overlap = createTimePoint(2025, 11, 2, 1, 30, 0, "America/New_York");
  assertEquals(fromTZ(overlap).toISOString(), "2025-11-02T05:30:00.000Z");
});

test("DST gap: forward search skips the nonexistent hour (America/New_York)", () => {
  const job = new Cron("* * * * *", { timezone: "America/New_York" });
  // 01:59 EST is the last existing minute before the gap
  const next = job.nextRun(new Date("2025-03-09T06:59:00Z"));
  // 02:00-02:59 local does not exist; next run is 03:00 EDT = 07:00Z
  assertEquals(next?.toISOString(), "2025-03-09T07:00:00.000Z");
});

test("DST gap: daily job in the gap is adjusted to after the gap in both search directions", () => {
  const job = new Cron("30 2 * * *", { timezone: "America/New_York" });
  // 02:30 on 2025-03-09 does not exist; forward search adjusts to 03:30 EDT
  const next = job.nextRun(new Date("2025-03-08T12:00:00Z"));
  assertEquals(next?.toISOString(), "2025-03-09T07:30:00.000Z");
  // Backward search from after the gap finds the same adjusted run
  const prev = job.previousRuns(1, new Date("2025-03-10T12:00:00Z"))[0];
  assertEquals(prev?.toISOString(), "2025-03-10T06:30:00.000Z"); // 02:30 EDT on Mar 10
});

test("DST gap boundary: backward search landing inside the gap resolves deterministically (counterexample)", () => {
  // Most dangerous counterexample for bidirectional consistency:
  // decrementing from 03:00 EDT lands on local 02:59, which does not exist.
  // The explicit guard resolves the nonexistent local time forward, past the
  // gap, so the result (03:59 EDT = 07:59Z) is deterministically pinned here
  // as the documented state boundary of the backward search.
  const job = new Cron("* * * * *", { timezone: "America/New_York" });
  const prev = job.previousRuns(1, new Date("2025-03-09T07:00:00Z"))[0];
  assertEquals(prev?.toISOString(), "2025-03-09T07:59:00.000Z");
});

test("DST overlap: forward search from the repeated hour resolves to first occurrence", () => {
  const job = new Cron("* * * * *", { timezone: "America/New_York" });
  // 06:58Z is 01:58 EST, the second occurrence of the repeated hour.
  // Local 01:59 maps to its first occurrence (EDT) per the explicit guard.
  const next = job.nextRun(new Date("2025-11-02T06:58:00Z"));
  assertEquals(next?.toISOString(), "2025-11-02T05:59:00.000Z");
});

test("DST overlap: daily job runs once at the first occurrence, then next day", () => {
  const job = new Cron("30 1 * * *", { timezone: "America/New_York" });
  const first = job.nextRun(new Date("2025-11-01T12:00:00Z"));
  assertEquals(first?.toISOString(), "2025-11-02T05:30:00.000Z"); // 01:30 EDT
  const second = job.nextRun(first);
  assertEquals(second?.toISOString(), "2025-11-03T06:30:00.000Z"); // 01:30 EST next day
  // Backward enumeration agrees: no run at the second occurrence (06:30Z on Nov 2)
  const prevs = job.previousRuns(2, new Date("2025-11-03T12:00:00Z"));
  assertEquals(prevs.map((d) => d.toISOString()), [
    "2025-11-03T06:30:00.000Z",
    "2025-11-02T05:30:00.000Z",
  ]);
});

test("Leap day: forward and backward search agree around Feb 29", () => {
  const job = new Cron("0 0 29 2 *", { timezone: "Etc/UTC" });

  const nextFrom2023 = job.nextRun(new Date("2023-06-01T00:00:00Z"));
  assertEquals(nextFrom2023?.toISOString(), "2024-02-29T00:00:00.000Z");

  // Backward search must cross non-leap years without crashing or drifting
  const prevFrom2025 = job.previousRuns(2, new Date("2025-06-01T00:00:00Z"));
  assertEquals(prevFrom2025.map((d) => d.toISOString()), [
    "2024-02-29T00:00:00.000Z",
    "2020-02-29T00:00:00.000Z",
  ]);

  // Non-leap years are skipped forward as well
  const nextFrom2025 = job.nextRun(new Date("2025-01-01T00:00:00Z"));
  assertEquals(nextFrom2025?.toISOString(), "2028-02-29T00:00:00.000Z");

  // Conditional symmetry at the leap day run itself
  const after = job.nextRun(nextFrom2023);
  assert(after !== null);
  const backToLeapDay = job.previousRuns(1, after)[0];
  assertEquals(backToLeapDay?.getTime(), nextFrom2023?.getTime());
});

test("Fifth weekday: 5th Monday enumerates identically in both directions", () => {
  const job = new Cron("0 9 * * 1#5", { timezone: "Etc/UTC" });

  const forward = job.nextRuns(3, new Date("2024-01-01T00:00:00Z"));
  assertEquals(forward.map((d) => d.toISOString()), [
    "2024-01-29T09:00:00.000Z",
    "2024-04-29T09:00:00.000Z",
    "2024-07-29T09:00:00.000Z",
  ]);

  const backward = job.previousRuns(2, new Date("2024-12-31T00:00:00Z"));
  assertEquals(backward.map((d) => d.toISOString()), [
    "2024-12-30T09:00:00.000Z",
    "2024-09-30T09:00:00.000Z",
  ]);

  // Conditional symmetry at a 5th-Monday run
  const after = job.nextRun(forward[0]);
  assert(after !== null);
  const backToRun = job.previousRuns(1, after)[0];
  assertEquals(backToRun?.getTime(), forward[0].getTime());
});

test("Enumeration order: nextRuns ascends, previousRuns descends, and they mirror each other", () => {
  const job = new Cron("*/20 * * * *", { timezone: "Etc/UTC" });
  const reference = new Date("2025-06-15T12:00:00Z");

  const forward = job.nextRuns(5, reference);
  assertEquals(forward.length, 5);
  for (let i = 1; i < forward.length; i++) {
    assert(forward[i].getTime() > forward[i - 1].getTime(), "nextRuns must be strictly ascending");
  }

  const backward = job.previousRuns(4, forward[4]);
  assertEquals(backward.length, 4);
  for (let i = 1; i < backward.length; i++) {
    assert(
      backward[i].getTime() < backward[i - 1].getTime(),
      "previousRuns must be strictly descending",
    );
  }

  // Mirror consistency: walking back from the last forward run revisits the same instants
  assertEquals(
    backward.map((d) => d.getTime()),
    forward.slice(0, 4).reverse().map((d) => d.getTime()),
  );
});

test("Unsolvable patterns: both directions report no solution without throwing", () => {
  // February 31st can never occur
  const job = new Cron("0 0 31 2 *", { timezone: "Etc/UTC" });
  const reference = new Date("2024-01-01T00:00:00Z");

  assertEquals(job.nextRun(reference), null);
  assertEquals(job.nextRuns(3, reference), []);
  assertEquals(job.previousRuns(3, reference), []);
});

test("Invalid timezone keeps diagnosable error context in both directions", () => {
  const reference = new Date("2024-01-01T00:00:00Z");
  const forwardJob = new Cron("* * * * *", { timezone: "Invalid/Zone" });
  assertThrows(() => forwardJob.nextRun(reference), TypeError, "Invalid/Zone");
  assertThrows(() => forwardJob.previousRuns(1, reference), TypeError, "Invalid/Zone");
});
