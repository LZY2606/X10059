/**
 * Regression tests for the explicit DST transition guard and the
 * direction-parameterized calendar search core.
 *
 * Every case uses fixed UTC instants and named IANA timezones. No case reads
 * the system clock or depends on the machine local timezone.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron, CronDate } from "../src/croner.ts";
import { resolveLocalTime } from "../src/helpers/timezone.ts";

test("DST guard: regular wall time resolves once", () => {
  const resolved = resolveLocalTime(2025, 1, 15, 12, 0, 0, "America/New_York");
  assertEquals(resolved.kind, "regular");
  assertEquals(resolved.instant.toISOString(), "2025-01-15T17:00:00.000Z");
  assert(resolved.secondInstant === undefined);
});

test("DST guard: 60-minute spring gap maps to the first instant after the gap", () => {
  // America/New_York 2025-03-09 02:00 EST -> 03:00 EDT; 02:30 does not exist.
  const resolved = resolveLocalTime(2025, 3, 9, 2, 30, 0, "America/New_York");
  assertEquals(resolved.kind, "gap");
  assertEquals(resolved.instant.toISOString(), "2025-03-09T07:30:00.000Z");
});

test("DST guard: 60-minute fall overlap resolves to the first occurrence and reports the second", () => {
  // America/New_York 2025-11-02 02:00 EDT -> 01:00 EST; 01:30 occurs twice.
  const resolved = resolveLocalTime(2025, 11, 2, 1, 30, 0, "America/New_York");
  assertEquals(resolved.kind, "overlap");
  assertEquals(resolved.instant.toISOString(), "2025-11-02T05:30:00.000Z");
  assertEquals(resolved.secondInstant?.toISOString(), "2025-11-02T06:30:00.000Z");
});

test("DST guard: 30-minute Lord Howe gap and overlap are classified without hard-coded 60 minutes", () => {
  // Spring forward 2025-10-05 02:00 +10:30 -> 02:30 +11:00.
  const gap = resolveLocalTime(2025, 10, 5, 2, 15, 0, "Australia/Lord_Howe");
  assertEquals(gap.kind, "gap");
  // Fall back 2025-04-06 02:00 +11:00 -> 01:30 +10:30.
  const overlap = resolveLocalTime(2025, 4, 6, 1, 45, 0, "Australia/Lord_Howe");
  assertEquals(overlap.kind, "overlap");
  assertEquals(overlap.instant.toISOString(), "2025-04-05T14:45:00.000Z");
  assertEquals(overlap.secondInstant?.toISOString(), "2025-04-05T15:15:00.000Z");
});

test("DST guard: 45-minute Chatham overlap is classified correctly", () => {
  // Chatham fall back 2025-04-06 03:45 +13:45 -> 02:45 +12:45; wall 03:30
  // repeats (13:45Z in summer, 14:45Z in winter).
  const resolved = resolveLocalTime(2025, 4, 6, 3, 30, 0, "Pacific/Chatham");
  assertEquals(resolved.kind, "overlap");
  assertEquals(resolved.instant.toISOString(), "2025-04-05T13:45:00.000Z");
  assertEquals(resolved.secondInstant?.toISOString(), "2025-04-05T14:45:00.000Z");
});

test("DST guard: CronDate records the transition kind while resolving a run", () => {
  // Construct the wall-time components that a pattern search lands on and
  // force resolution to a real instant; lastDstKind exposes the guard call.
  const date = new CronDate("2025-03-09T02:30:00", "America/New_York");
  date.getDate(false);
  assertEquals(date.lastDstKind, "gap");

  const regular = new CronDate("2025-01-15T12:00:00", "America/New_York");
  regular.getDate(false);
  assertEquals(regular.lastDstKind, "regular");

  const overlap = new CronDate("2025-11-02T01:30:00", "America/New_York");
  overlap.getDate(false);
  assertEquals(overlap.lastDstKind, "overlap");
});

test("DST guard: invalid IANA timezone keeps diagnostic context", () => {
  try {
    resolveLocalTime(2025, 1, 1, 0, 0, 0, "Not/A_Zone");
    assert(false, "expected a timezone error");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    assert(message.includes("Not/A_Zone"), `error must name the timezone: ${message}`);
    assert(
      message.toLowerCase().includes("timezone") || message.toLowerCase().includes("range"),
      `error must carry diagnostic context: ${message}`,
    );
  }
});

test("search core: impossible calendar days return null in both directions instead of throwing", () => {
  for (const pattern of ["0 0 30 2 *", "0 0 31 4 *"]) {
    const job = new Cron(pattern, { paused: true, timezone: "UTC" });
    // Forward reaches the supported-year limit and returns null cleanly.
    assertEquals(job.nextRun("2024-01-01T00:00:00Z"), null, `${pattern} forward`);
    // Backward previously crashed with "Cannot read properties of undefined
    // (reading '0')" or an invalid-date TypeError; it must now return [].
    let threw: unknown = null;
    let backward: Date[] = [];
    try {
      backward = job.previousRuns(1, "2026-06-01T00:00:00Z");
    } catch (e) {
      threw = e;
    }
    assertEquals(threw, null, `${pattern} backward must not throw`);
    assertEquals(backward, [], `${pattern} backward`);
    job.stop();
  }
});

test("search core: leap day enumerates identically in both directions across leap cycles", () => {
  const job = new Cron("0 0 29 2 *", { paused: true, timezone: "UTC" });
  const forward = job.nextRuns(4, "2020-01-01T00:00:00Z").map((d) => d.toISOString());
  assertEquals(forward, [
    "2020-02-29T00:00:00.000Z",
    "2024-02-29T00:00:00.000Z",
    "2028-02-29T00:00:00.000Z",
    "2032-02-29T00:00:00.000Z",
  ]);
  const backward = job.previousRuns(4, "2033-01-01T00:00:00Z").map((d) => d.toISOString())
    .reverse();
  assertEquals(backward, forward);
  job.stop();
});

test("search core: backward leap-day search from a non-leap reference finds the prior leap year", () => {
  const job = new Cron("0 0 29 2 *", { paused: true, timezone: "UTC" });
  const previous = job.previousRuns(1, "2025-06-01T00:00:00Z");
  assertEquals(previous.map((d) => d.toISOString()), ["2024-02-29T00:00:00.000Z"]);
  job.stop();
});

test("search core: month-constrained last day (L in February) skips non-February months in both directions", () => {
  const job = new Cron("0 0 L 2 *", { paused: true, timezone: "UTC" });
  const forward = job.nextRuns(3, "2023-06-01T00:00:00Z").map((d) => d.toISOString());
  assertEquals(forward, [
    "2024-02-29T00:00:00.000Z",
    "2025-02-28T00:00:00.000Z",
    "2026-02-28T00:00:00.000Z",
  ]);
  const backward = job.previousRuns(3, "2026-06-01T00:00:00Z").map((d) => d.toISOString())
    .reverse();
  assertEquals(backward, forward);
  job.stop();
});

test("search core: fifth weekday is not fabricated for months that only have four", () => {
  const job = new Cron("0 0 * * 5#5", { paused: true, timezone: "UTC" });
  // February 2025 has only four Fridays; enumerating across it must simply
  // skip the month in both directions.
  const forward = job.nextRuns(4, "2025-01-15T00:00:00Z").map((d) => d.toISOString());
  assertEquals(forward, [
    "2025-01-31T00:00:00.000Z",
    "2025-05-30T00:00:00.000Z",
    "2025-08-29T00:00:00.000Z",
    "2025-10-31T00:00:00.000Z",
  ]);
  const backward = job.previousRuns(4, "2025-11-15T00:00:00Z").map((d) => d.toISOString())
    .reverse();
  assertEquals(backward, forward);
  job.stop();
});

test("search core: repeated local time is scheduled once at the first occurrence", () => {
  const job = new Cron("30 1 * * *", { paused: true, timezone: "America/New_York" });
  // First occurrence 01:30 EDT = 05:30Z; the duplicate 01:30 EST (06:30Z) is
  // not a second scheduled run.
  assertEquals(
    job.nextRun("2025-11-02T04:00:00Z")?.toISOString(),
    "2025-11-02T05:30:00.000Z",
  );
  assertEquals(
    job.nextRun("2025-11-02T05:31:00Z")?.toISOString(),
    "2025-11-03T06:30:00.000Z",
  );
  job.stop();
});
