# Changelog

All notable changes to Croner will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Converged forward/backward calendar search**: `CronDate.increment` and
  `CronDate.decrement` now share a single direction-parameterized search
  core (`searchMatch`, direction `1`/`-1`) in `src/date.ts`. The previous
  implementation carried the month/day/weekday join logic in two parallel
  recursive routines (`recurse` and `recurseBackward`) that had drifted in
  subtle ways. The core is an iterative state machine rather than a
  recursive one, so patterns without a solution (e.g. `0 0 30 2 *`) no
  longer consume native stack frames while carrying through thousands of
  years. Public return values of `nextRun`, `previousRun` and `nextRuns`,
  enumeration order, and the no-solution contract (`null` / empty array)
  are unchanged.
- **Explicit DST transition guard**: wall-time to instant resolution for
  named IANA timezones now goes through `resolveLocalTime` in
  `src/helpers/timezone.ts`. It returns an explicit classification
  (`regular`, `gap`, `overlap`) and, for fall-back overlaps, both the first
  and second occurrence. Non-existent local times still map to the first
  instant after the gap, and repeated local times still resolve to their
  first occurrence, preserving every previously locked result. The guard
  does not assume a 60-minute transition: it classifies the 30-minute
  `Australia/Lord_Howe` and 45-minute `Pacific/Chatham` transitions with
  the same code path. The most recent classification is observable on
  `CronDate#lastDstKind` for replay/evidence.

### Fixed
- Backward search (`previousRuns`/`decrement`) threw
  `TypeError: Cannot read properties of undefined (reading '0')` for
  leap-day patterns such as `0 0 29 2 *` and an invalid-date `TypeError`
  for impossible days such as `0 0 30 2 *`, while the equivalent forward
  search correctly returned matches or `null`. Both directions now share
  the one search core, so impossible days return `null`/`[]` cleanly and
  leap days enumerate identically in both directions.

### Tests
- Added `test/bidirectional-contract.test.ts`, written before the
  structural change to lock the parallel implementations to one shared
  contract: forward enumeration equals reversed backward enumeration for
  month-end, leap-day, nearest-weekday (`W`), last-weekday (`LW`) and
  nth/last weekday (`#n`/`L`) patterns across `UTC`, `America/New_York`,
  `Europe/London`, `Australia/Lord_Howe` and `Pacific/Chatham`.
- The contract verifies conditional point symmetry
  `next(previous(ref) - 1s) === previous(ref)` for every minute of real
  spring-gap and fall-overlap transition days, with the symmetry exemption
  applied only when the found match itself resolves a non-existent or
  repeated local time. Every case uses fixed UTC instants and named IANA
  timezones; the system clock and system local timezone are never read.
- Added `test/dst-transition-guard.test.ts` covering the guard on 60/30/45
  minute transitions, the `CronDate#lastDstKind` replay surface, the
  impossible-day no-solution contract in both directions, leap-cycle
  enumeration, month-constrained last-day (`L` in February), months
  without a fifth weekday, and first-occurrence scheduling in an overlap.

### Test environment note
- The repository's pre-existing tests and the new contract/guard tests pass
  cleanly with a fixed `TZ=UTC` (the CI runs on UTC hosts). A handful of
  legacy tests construct bare local `Date` values and therefore fail on a
  machine whose system timezone is not UTC (e.g. `Asia/Tokyo`); this is
  pre-existing behavior unrelated to this change, and the set of failing
  files is identical before and after. All newly added tests use fixed UTC
  instants with explicit IANA timezones and pass under any system timezone.

### Most dangerous counterexample and its regression test
- The single most dangerous counterexample is the **leap-day backward
  carry** for `0 0 29 2 *` starting from a non-leap year (e.g.
  `previousRuns(1, 2025-06-01)`). The old backward routine matched day 29
  in February, normalized the non-existent `2025-02-29` forward to
  `2025-03-01`, then re-entered the recursion with level `-1`; that level
  indexed `RecursionSteps[-1]`, dereferenced an undefined step and threw.
  The forward twin handled the same situation by rolling forward to the
  next February. Impossible days (`0 0 30 2 *`) exposed the same defect as
  a stack overflow. It is pinned by "search core: backward leap-day search
  from a non-leap reference finds the prior leap year" and "impossible
  calendar days return null in both directions instead of throwing" in
  `test/dst-transition-guard.test.ts`, plus the leap-cycle enumeration
  contract in `test/bidirectional-contract.test.ts`.

### Coverage gaps in the original suite
- The original tests asserted forward leap-day results and forward DST
  gap/overlap behavior, but never compared forward and backward
  enumeration as one sequence. The backward leap-day crash and the
  impossible-day crash therefore shipped unobserved, and there was no
  regression for `L` constrained to a single month in either direction.
- DST coverage only exercised 60-minute transitions (New York, London).
  30/45-minute transitions were untested, and there was no observable
  distinction between "regular run", "gap-mapped run" and
  "overlap-first-occurrence run".

### Adjacent semantics protected against regression
- Strict-exclusive boundaries: `nextRun(t)` and `previousRuns(1, t)` at an
  exact match return the next, not the input (the search core still
  moves one second before matching).
- DST gap scheduling skip (`0 30 2` jumps to 03:30), overlap first
  occurrence (`0 30 1` is scheduled once, at the earlier offset), the
  #286 "no rapid-fire across fall-back" behavior and #284 UTC hour
  skipping remain covered by the pre-existing tests, which all pass.
- `domAndDow` OR/AND semantics, `W`/`LW`/`#n`/`L` modifiers, fixed numeric
  `utcOffset` jobs (which have no DST and bypass the guard), `dayOffset`,
  `startAt`/`stopAt`, `interval`, one-off date jobs and the year 3000
  wildcard bound are unchanged.

## [10.0.1] - 2026-02-01

### Fixed
- Bundle TypeScript declarations into single file to match 9.1.0 dist structure

## [10.0.0] - 2026-02-01

### Added
- **OCPS 1.2 Compliance**: Year field support for 7-field patterns (range 1-9999) (#288)
- **OCPS 1.3 Compliance**: W (weekday) modifier for nearest weekday scheduling (#288)
- **OCPS 1.4 Compliance**: + (AND logic) modifier for explicit day matching (#288)
- **OCPS 1.4 Compliance**: @midnight and @reboot pattern nicknames (#288)
- `previousRuns()` method to enumerate past scheduled execution times (#315)
- `match()` method to check if a date matches a cron pattern (#317)
- `getOnce()` method to return original run-once date for date-based jobs (#332)
- `dayOffset` option for scheduling before/after pattern matches (#308)
- `mode` option for cron pattern precision control with enforcement and flexible modes (#294)
- `alternativeWeekdays` option for Quartz-style weekday numbering (1=Sunday...7=Saturday) (#312)
- `domAndDow` option to replace deprecated `legacyMode` (no breaking change) (#309)
- `sloppyRanges` option to allow relaxed, backward-compatible non-standard range/stepping syntax (#327)
- Support for leading/trailing whitespace and consecutive whitespace in patterns
- Case-insensitive L and W modifiers in cron patterns (#328)
- Comprehensive edge case tests for year stepping, nth weekday, W modifier, Quartz mode, and boundary conditions (#329)

### Changed
- **BREAKING**: `?` character now acts as wildcard alias (same as `*`) per OCPS 1.4, instead of substituting current time values (#293)
- **BREAKING**: Minimum Deno version increased from 1.16 to 2.0
- Renamed `legacyMode` option to `domAndDow` (backward compatible, `legacyMode` still works) (#309)
- Improved error messages for timezone/date conversion failures (#307)
- Unified implementations of `nextRuns`/`previousRuns` and `findNext`/`findPrevious` (#319)
- Refactored to extract duplicate code patterns into helper methods (#322)
- Consolidated duplicate tests across OCPS compliance and legacy test suites (#320)

### Fixed
- DST bugs causing rapid-fire execution during timezone transitions (Issue #286) (#285)
- DST bug with UTC timezone causing hour skipping during local DST transitions (Issue #284) (#285)
- Cron job stopping when catch callback throws with protect enabled (#337)
- L modifier bug and documented W modifier edge cases (#306)
- `getPattern()` returning wrong value for date-based jobs (#331)
- Node.js timezone test failures caused by hour 24 midnight formatting (#291)
- Unclear error messages for timezone/date conversion failures (#307)

### Documentation
- Complete OCPS 1.0-1.4 compliance documentation (#292)
- Migration guide for v9.x to v10.0 upgrade path (#310)
- Documented zero dependencies advantage over Luxon-dependent alternatives (#318)
- Updated year field in README ASCII pattern diagram (#311)
- Documented `getOnce()` and `previousRuns()` features (#333)

## [9.1.0] - 2024-10-21

### Added
- Generic context typing support
- Improved timeout adaptations in tests

### Changed
- Updated documentation and readme
- Allow leading/trailing whitespace in patterns

### Fixed
- Various bug fixes and improvements

---

For older releases, see [GitHub Releases](https://github.com/Hexagon/croner/releases).
