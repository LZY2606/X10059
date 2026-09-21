# Changelog

All notable changes to Croner will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Explicit DST transition guard**: new `resolveDSTTransition()` helper in `src/helpers/timezone.ts`
  classifies any local time point as `unique`, `gap` (nonexistent local time, spring forward) or
  `overlap` (repeated local time, fall back) and resolves it deterministically: gaps resolve to the
  first valid instant after the gap, overlaps to the first occurrence (per OCPS 1.4). `fromTZ()` now
  delegates to this guard, so the local→UTC conversion used by both search directions has one
  explicit, testable state boundary. The overlap probe checks both directions (±1h and ±30min, the
  latter for half-hour transitions such as `Australia/Lord_Howe`), fixing misclassification of
  overlaps where the first UTC guess landed on the first occurrence (e.g. `America/New_York`
  fall-back). Resolved instants are unchanged for all inputs.
- **Bidirectional search contract tests** (`test/bidirectional-search.test.ts`): 17 tests locking the
  shared contract of the converged next/previous search across five IANA timezones
  (`Etc/UTC`, `America/New_York`, `Europe/Stockholm`, `Australia/Sydney`, `Asia/Tokyo`). All tests
  use explicit `timezone` options and fixed reference instants, so they pass under any system
  timezone and never read the wall clock.

### Changed
- **Converged next/previous search core**: the parallel `recurse()`/`recurseBackward()` traversals in
  `src/date.ts` are replaced by a single direction-parameterized `seek(pattern, options, doing,
  direction)` core (mirroring the already-unified `findMatch`). `increment()`/`decrement()` keep
  their signatures and delegate to it. Public return values of `nextRun`, `previousRun(s)`,
  `nextRuns`, enumeration order (next ascending, previous descending) and the null/empty error
  semantics for unsolvable patterns are preserved.

### Fixed
- **Backward search crash on day overflow** (found by the new contract tests): `previousRuns()` on
  patterns whose day-of-month can exceed the days in a month — e.g. leap-day pattern `0 0 29 2 *`
  across a non-leap February, or unsolvable `0 0 31 2 *` — reset the day to a value that does not
  exist in the current month. `apply()` then rolled the overflow into the next month and the
  recursion continued at level -1, crashing with `TypeError: Cannot read properties of undefined`.
  Backward day resets are now capped at the actual last day of the current month, and the
  parent-level recursion is clamped at the month level. Unsolvable patterns now correctly return
  `null`/`[]` from both directions instead of throwing.
- Recursion safety guard in the unified `seek` lowered from 10000 to 1000 frames: legitimate matches
  are always found within a 4-year leap cycle (~100 frames), while deeper recursion only occurs for
  unsolvable patterns and previously overflowed the call stack before the guard could return null.

### Coverage gaps closed (previously untested state boundaries)
- No test exercised `previousRuns()` across DST transitions, leap days, or fifth weekdays; the
  backward traversal had no shared contract with the forward one, which let the day-overflow crash
  above ship undetected.
- The DST overlap probe in `fromTZ()` was asymmetric (only checked one hour earlier), so overlap
  classification depended on which occurrence the first guess happened to land on.

### Regression protection for adjacent semantics
- OCPS 1.4 gap/overlap resolution (`fromTZ` throw-on-invalid, first-occurrence rule), the rapid-fire
  guard for issue #286, the UTC-offset path for issue #284, enumeration order, `dayOffset`, `interval`,
  `startAt`/`stopAt` bounds and one-off schedules are all pinned by the existing 538-test suite, which
  passes unchanged; error messages keep their diagnosable context (timezone name, original cause).

### Most dangerous counterexample (documented state boundary)
- **Backward search landing inside a spring-forward gap**: with `* * * * *` in `America/New_York`,
  `previousRuns(1, 2025-03-09T07:00:00Z)` decrements from 03:00 EDT onto local 02:59, which does not
  exist. The explicit guard resolves the nonexistent local time forward, past the gap, yielding
  `2025-03-09T07:59:00Z` — a "previous" run that is later than the reference. This is the sharpest
  edge of bidirectional consistency: plain `previous(next(t)) === t` symmetry is only *conditional*
  and does not extend into DST transition windows. The resolution is deterministic and is now pinned
  by the regression test `DST gap boundary: backward search landing inside the gap resolves
  deterministically (counterexample)` in `test/bidirectional-search.test.ts`, together with the
  forward-direction counterpart (`nextRun` from the repeated fall-back hour resolving to the first
  occurrence), so any future change to this boundary is an explicit, reviewed decision rather than
  silent drift.

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
