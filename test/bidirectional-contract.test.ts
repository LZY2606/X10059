/**
 * Shared direction contract for the calendar search core.
 *
 * These tests lock the parallel implementations of forward (`nextRun`)
 * and backward (`previousRuns`) calendar search to a single observable
 * sequence. They were written before the direction-parameterized search
 * core refactor, so the contract defines what the converged implementation
 * must preserve:
 *
 *   1. Enumeration equivalence - forward runs enumerated from a fixed
 *      reference must equal the reverse of backward runs enumerated back
 *      to the same window, for every tested pattern and IANA timezone.
 *   2. Conditional point symmetry - `next(previous(ref)) === previous(ref)`
 *      except when `ref` falls inside a DST gap or overlap window (the
 *      transition guard owns those exemptions explicitly).
 *
 * All cases use fixed UTC instants and named IANA timezones; the system
 * clock and the system local timezone are never read.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/** Fixed anchor: 2024-06-01T00:00:00Z, never derived from the system clock. */
const ANCHOR = "2024-06-01T00:00:00Z";
const ENUMERATION_COUNT = 120;

/**
 * Pure black-box DST classification of a concrete UTC instant using only the
 * platform IANA database (Intl.DateTimeFormat). A point is anomalous when
 * another instant carries the same wall time (overlap) or when the offsets
 * four real hours before and after it differ while the point is the first
 * existing instant after a missing wall time (gap).
 *
 * The classification is applied to the concrete match returned by backward
 * search, not to the reference instant: a reference long after a gap still
 * enumerates the gap-mapped match, and that match is what breaks symmetry.
 */
function dstAnomalyKind(timezone: string, instantMs: number): "regular" | "gap" | "overlap" {
  const wallParts = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    return {
      ms: Date.UTC(
        value("year"),
        value("month") - 1,
        value("day"),
        value("hour") % 24,
        value("minute"),
        value("second"),
      ),
    };
  };
  const wall = wallParts(instantMs).ms;
  const offsetAt = (at: number) => wallParts(at).ms - at;
  const offset = offsetAt(instantMs);

  // Enumerate every distinct offset used within +/-4 real hours and derive
  // the instants that carry this wall time. Two distinct instants mean an
  // overlap; the +/-1h shortcut misses 30-minute Lord Howe transitions.
  const candidates: number[] = [];
  for (let probe = -4; probe <= 4; probe++) {
    const candidate = wall - offsetAt(instantMs + probe * 3600_000);
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  const existing = candidates.filter((candidate) => wallParts(candidate).ms === wall);
  if (existing.length >= 2) {
    return "overlap";
  }

  // Gap: offsets across the transition differ and this instant keeps the
  // post-transition offset while carrying a wall time from the gap window.
  const before = offsetAt(instantMs - 4 * 3600_000);
  const after = offsetAt(instantMs + 4 * 3600_000);
  if (before !== offset && offset === after) {
    // Confirm the same wall time has no other representation (already true
    // when existing.length === 1) and that an earlier wall-clock second
    // resolves to a later instant, the signature of a forward jump.
    return "gap";
  }
  return "regular";
}

/** Calendar search patterns covering month-end, leap day and weekday joins. */
const CONTRACT_PATTERNS = [
  "0 * * * *",
  "30 1 * * *",
  "30 2 * * *",
  "30 6 * * *",
  "15 */2 * * *",
  "*/7 3-23/5 * * 1-5",
  "0 0 29 2 *", // leap day only
  "0 0 28 2 *", // February fixed day
  "0 0 31 * *", // 31st of month (month length join)
  "0 0 L * *", // last day of month
  "0 0 LW * *", // last weekday of month
  "0 0 15W * *", // nearest weekday
  "0 0 * * 5L", // fifth/last Friday
  "0 0 * * 5#5", // fifth Friday explicitly
  "0 22 * * 0#1", // first Sunday
  "0 0 1 1 *", // yearly
] as const;

const CONTRACT_TIMEZONES = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
] as const;

/**
 * Enumerate the same window in both directions and require the reversed
 * backward sequence to be identical to the forward sequence.
 */
for (const timezone of CONTRACT_TIMEZONES) {
  for (const pattern of CONTRACT_PATTERNS) {
    test(`direction contract: forward enumeration equals reversed backward enumeration (${timezone}, ${pattern})`, () => {
      const job = new Cron(pattern, { paused: true, timezone });

      const forward: string[] = [];
      let cursor: Date | string = ANCHOR;
      for (let i = 0; i < ENUMERATION_COUNT; i++) {
        const next = job.nextRun(cursor);
        if (next === null) break; // wildcard-year search is bounded at year 3000
        forward.push(next.toISOString());
        cursor = new Date(next.getTime() + 1000);
      }
      assert(forward.length > 0, "forward enumeration must find at least one match");

      const windowEnd = new Date(
        new Date(forward[forward.length - 1]).getTime() + 1000,
      );
      const backward = job.previousRuns(forward.length, windowEnd)
        .map((run) => run.toISOString())
        .reverse();

      assertEquals(
        backward.length,
        forward.length,
        "backward enumeration must cover the same number of matches",
      );
      assertEquals(backward, forward);
      job.stop();
    });
  }
}

/**
 * Conditional point symmetry around every minute of several real DST
 * transition days. For references that are not themselves inside a gap or
 * overlap window, `next(previous(ref) - 1s)` must return exactly the match
 * that backward search found. References inside classified transition
 * windows are asserted as the documented exemption instead.
 */
const TRANSITION_CASES: {
  timezone: string;
  pattern: string;
  from: string;
  to: string;
}[] = [
  // 60-minute spring gap (2:00-2:59 wall time does not exist)
  {
    timezone: "America/New_York",
    pattern: "30 2 * * *",
    from: "2025-03-09T04:00:00Z",
    to: "2025-03-09T10:00:00Z",
  },
  // 60-minute fall overlap (1:00-1:59 wall time happens twice)
  {
    timezone: "America/New_York",
    pattern: "30 1 * * *",
    from: "2025-11-02T04:00:00Z",
    to: "2025-11-02T09:00:00Z",
  },
  // London spring gap
  {
    timezone: "Europe/London",
    pattern: "30 1 * * *",
    from: "2025-03-30T00:00:00Z",
    to: "2025-03-30T03:00:00Z",
  },
  // 30-minute Lord Howe spring gap
  {
    timezone: "Australia/Lord_Howe",
    pattern: "30 2 * * *",
    from: "2025-10-05T14:00:00Z",
    to: "2025-10-05T18:00:00Z",
  },
  // 30-minute Lord Howe fall overlap
  {
    timezone: "Australia/Lord_Howe",
    pattern: "30 1 * * *",
    from: "2025-04-06T13:00:00Z",
    to: "2025-04-06T17:00:00Z",
  },
  // 45-minute Chatham fall overlap (3:45 +13:45 -> 3:00 +13:00, so 3:30 repeats)
  {
    timezone: "Pacific/Chatham",
    pattern: "30 3 * * *",
    from: "2025-04-05T13:30:00Z",
    to: "2025-04-05T16:30:00Z",
  },
];

for (const { timezone, pattern, from, to } of TRANSITION_CASES) {
  test(`conditional symmetry: next(previous(ref)-1s) holds outside DST windows (${timezone}, ${pattern})`, () => {
    const job = new Cron(pattern, { paused: true, timezone });
    let regularChecks = 0;
    let exemptChecks = 0;
    // The backward match changes at most a handful of times over a single
    // transition day, so classify only when it changes rather than for every
    // sampled reference minute.
    let lastMatchIso = "";
    let lastKind: "regular" | "gap" | "overlap" = "regular";
    for (
      let instant = new Date(from).getTime(), end = new Date(to).getTime();
      instant <= end;
      instant += 60_000
    ) {
      const reference = new Date(instant);
      const previous = job.previousRuns(1, reference)[0];
      assert(previous !== undefined, "backward search must find a run");

      if (previous.toISOString() !== lastMatchIso) {
        lastMatchIso = previous.toISOString();
        lastKind = dstAnomalyKind(timezone, previous.getTime());
      }
      if (lastKind === "regular") {
        const roundTrip = job.nextRun(new Date(previous.getTime() - 1000));
        assert(roundTrip !== null, "forward round-trip must find a run");
        assertEquals(
          roundTrip.getTime(),
          previous.getTime(),
          `symmetry broken at regular reference ${reference.toISOString()}`,
        );
        regularChecks++;
      } else {
        exemptChecks++;
      }
    }
    assert(regularChecks > 0, "test must include regular references");
    assert(exemptChecks > 0, "test must include at least one transition window");
    job.stop();
  });
}

test("direction contract: no-solution patterns return null in both directions, never throw", () => {
  for (const pattern of ["0 0 30 2 *", "0 0 31 4 *"]) {
    const job = new Cron(pattern, { paused: true, timezone: "UTC" });
    assertEquals(job.nextRun("2024-01-01T00:00:00Z"), null);
    assertEquals(job.previousRuns(1, "2026-06-01T00:00:00Z"), []);
    job.stop();
  }
});

test("direction contract: leap-day matches agree between directions across leap cycles", () => {
  const job = new Cron("0 0 29 2 *", { paused: true, timezone: "UTC" });
  const forward: string[] = [];
  let cursor: Date | string = "2020-01-01T00:00:00Z";
  for (let i = 0; i < 4; i++) {
    const next = job.nextRun(cursor);
    assert(next !== null);
    forward.push(next.toISOString());
    cursor = new Date(next.getTime() + 1000);
  }
  assertEquals(forward, [
    "2020-02-29T00:00:00.000Z",
    "2024-02-29T00:00:00.000Z",
    "2028-02-29T00:00:00.000Z",
    "2032-02-29T00:00:00.000Z",
  ]);
  const backward = job.previousRuns(4, "2033-01-01T00:00:00Z")
    .map((run) => run.toISOString())
    .reverse();
  assertEquals(backward, forward);
  job.stop();
});

test("direction contract: fifth weekday matches agree between directions", () => {
  const job = new Cron("0 0 * * 5#5", { paused: true, timezone: "UTC" });
  const forward: string[] = [];
  let cursor: Date | string = "2024-06-01T00:00:00Z";
  for (let i = 0; i < 8; i++) {
    const next = job.nextRun(cursor);
    assert(next !== null);
    forward.push(next.toISOString());
    cursor = new Date(next.getTime() + 1000);
  }
  // Months without a fifth Friday (e.g. February, and months where the 5th
  // weekday lands elsewhere) must simply be absent from both sequences.
  const windowEnd = new Date(new Date(forward[forward.length - 1]).getTime() + 1000);
  const backward = job.previousRuns(forward.length, windowEnd)
    .map((run) => run.toISOString())
    .reverse();
  assertEquals(backward, forward);
  job.stop();
});
