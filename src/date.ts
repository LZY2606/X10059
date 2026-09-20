import { fromTZISO, type LocalTimeKind, resolveLocalTime, toTZ } from "./helpers/timezone.ts";

import type { CronOptions as CronOptions } from "./options.ts";
import {
  ANY_OCCURRENCE,
  type CronPattern,
  LAST_OCCURRENCE,
  OCCURRENCE_BITMASKS,
} from "./pattern.ts";

/**
 * Constant defining the minimum number of days per month where index 0 = January etc.
 *
 * Used to look if a date _could be_ out of bounds. The "could be" part is why february is pinned to 28 days.
 *
 * @private
 *
 * @constant
 * @type {Number[]}
 */
const DaysOfMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Array of work to be done, consisting of subarrays described below:
 *
 * [
 *   First item is which member to process,
 *   Second item is which member to increment if we didn't find a mathch in current item,
 *   Third item is an offset. if months is handled 0-11 in js date object, and we get 1-12 from `this.minute`
 *   from pattern. Offset should be -1
 * ]
 */
type RecursionTarget = "month" | "day" | "hour" | "minute" | "second";
type RecursionTargetNext = RecursionTarget | "year";
type RecursionStep = [RecursionTarget, RecursionTargetNext, number];
const RecursionSteps: RecursionStep[] = [
  ["month", "year", 0],
  ["day", "month", -1],
  ["hour", "day", 0],
  ["minute", "hour", 0],
  ["second", "minute", 0],
];

/**
 * Converts date to CronDate
 *
 * @param d Input date, if using string representation ISO 8001 (2015-11-24T19:40:00) local timezone is expected
 * @param tz String representation of target timezone in Europe/Stockholm format, or a number representing offset in minutes.
 */
class CronDate<T = undefined> {
  tz: string | number | undefined;

  /**
   * DST transition classification produced by the most recent wall-time to
   * instant resolution ({@link getDate}). Undefined until the first
   * resolution, or when a fixed numeric UTC offset (which has no DST) is used.
   *
   * This is observable evidence of the explicit transition guard: callers
   * and tests can replay whether a computed run landed in a "gap", an
   * "overlap", or at a "regular" local time.
   */
  lastDstKind: LocalTimeKind | undefined;

  /**
   * Current milliseconds
   * @type {number}
   */
  ms!: number;

  /**
   * Current second (0-59), in local time or target timezone specified by `this.tz`
   * @type {number}
   */
  second!: number;

  /**
   * Current minute (0-59), in local time or target timezone specified by `this.tz`
   * @type {number}
   */
  minute!: number;

  /**
   * Current hour (0-23), in local time or target timezone specified by `this.tz`
   * @type {number}
   */
  hour!: number;

  /**
   * Current day (1-31), in local time or target timezone specified by `this.tz`
   * @type {number}
   */
  day!: number;

  /**
   * Current month (1-12), in local time or target timezone specified by `this.tz`
   * @type {number}
   */
  month!: number;
  /**
   * Current full year, in local time or target timezone specified by `this.tz`
   */
  year!: number;

  constructor(d?: CronDate<T> | Date | string | null, tz?: string | number) {
    /**
     * TimeZone
     * @type {string|number|undefined}
     */
    this.tz = tz;

    // Populate object using input date, or throw
    if (d && d instanceof Date) {
      if (!isNaN(d as unknown as number)) {
        this.fromDate(d);
      } else {
        throw new TypeError("CronDate: Invalid date passed to CronDate constructor");
      }
    } else if (d === void 0 || d === null) {
      this.fromDate(new Date());
    } else if (d && typeof d === "string") {
      this.fromString(d);
    } else if (d instanceof CronDate) {
      this.fromCronDate(d);
    } else {
      throw new TypeError(
        "CronDate: Invalid type (" + typeof d + ") passed to CronDate constructor",
      );
    }
  }

  /**
   * Calculates the last day of a given month.
   * Uses a performance optimization for months other than February.
   *
   * @param year The year
   * @param month The month (0-11)
   * @returns The last day of the month (1-31)
   * @private
   */
  private getLastDayOfMonth(year: number, month: number): number {
    // This is an optimization for every month except february
    if (month !== 1) {
      return DaysOfMonth[month];
    } else {
      return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    }
  }

  /**
   * Calculates the last weekday (Mon-Fri) of a given month.
   *
   * @param year The target year.
   * @param month The target month (0-11).
   * @returns The day of the month (1-31) that is the last weekday.
   * @private
   */
  private getLastWeekday(year: number, month: number): number {
    const lastDay = this.getLastDayOfMonth(year, month);
    const lastDate = new Date(Date.UTC(year, month, lastDay));
    const weekday = lastDate.getUTCDay(); // 0=Sun, 6=Sat

    if (weekday === 0) { // Sunday
      return lastDay - 2; // Go back to Friday
    } else if (weekday === 6) { // Saturday
      return lastDay - 1; // Go back to Friday
    }

    // It's already a weekday
    return lastDay;
  }

  /**
   * Calculates the nearest weekday (Mon-Fri) to a given day of the month.
   * Handles month boundaries.
   *
   * @param year The target year.
   * @param month The target month (0-11).
   * @param day The target day (1-31).
   * @returns The day of the month (1-31) that is the nearest weekday, or -1 if the day doesn't exist in the month.
   */
  private getNearestWeekday(year: number, month: number, day: number): number {
    // Check if the requested day exists in the month
    const daysInMonth = this.getLastDayOfMonth(year, month);
    if (day > daysInMonth) {
      return -1; // Day doesn't exist in this month
    }

    const date = new Date(Date.UTC(year, month, day));
    const weekday = date.getUTCDay(); // 0=Sun, 6=Sat

    if (weekday === 0) { // Sunday
      // If it's the last day of the month, go back to Friday
      if (day === daysInMonth) {
        return day - 2;
      }
      // Otherwise, go forward to Monday
      return day + 1;
    }

    if (weekday === 6) { // Saturday
      // If it's the 1st, go forward to Monday
      if (day === 1) {
        return day + 2;
      }
      // Otherwise, go back to Friday
      return day - 1;
    }

    // It's already a weekday
    return day;
  }

  /**
   * Check if the given date is the nth occurrence of a weekday in its month.
   *
   * @param year The year.
   * @param month The month (0 for January, 11 for December).
   * @param day The day of the month.
   * @param nth The nth occurrence (bitmask).
   *
   * @return True if the date is the nth occurrence of its weekday, false otherwise.
   */
  private isNthWeekdayOfMonth(year: number, month: number, day: number, nth: number): boolean {
    const date = new Date(Date.UTC(year, month, day));
    const weekday = date.getUTCDay();

    // Count occurrences of the weekday up to and including the current date
    let count = 0;
    for (let d = 1; d <= day; d++) {
      if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) {
        count++;
      }
    }

    // Check for nth occurrence
    if (nth & ANY_OCCURRENCE && OCCURRENCE_BITMASKS[count - 1] & nth) {
      return true;
    }

    // Check for last occurrence
    if (nth & LAST_OCCURRENCE) {
      const daysInMonth = this.getLastDayOfMonth(year, month);
      for (let d = day + 1; d <= daysInMonth; d++) {
        if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) {
          return false; // There's another occurrence of the same weekday later in the month
        }
      }
      return true; // The current date is the last occurrence of the weekday in the month
    }

    return false;
  }

  /**
   * Sets internals using a Date
   */
  private fromDate(inDate: Date) {
    /* If this instance of CronDate has a target timezone set,
	 * use timezone utilities to convert input date object to target timezone
	 * before extracting hours, minutes, seconds etc.
	 *
	 * If not, extract all parts from inDate as-is.
	 */
    if (this.tz !== void 0) {
      if (typeof this.tz === "number") {
        this.ms = inDate.getUTCMilliseconds();
        this.second = inDate.getUTCSeconds();
        this.minute = inDate.getUTCMinutes() + this.tz;
        this.hour = inDate.getUTCHours();
        this.day = inDate.getUTCDate();
        this.month = inDate.getUTCMonth();
        this.year = inDate.getUTCFullYear();
        // Minute could be out of bounds, apply
        this.apply();
      } else {
        try {
          const d = toTZ(inDate, this.tz);
          this.ms = inDate.getMilliseconds();
          this.second = d.s;
          this.minute = d.i;
          this.hour = d.h;
          this.day = d.d;
          this.month = d.m - 1;
          this.year = d.y;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          throw new TypeError(
            `CronDate: Failed to convert date to timezone '${this.tz}'. ` +
              `This may happen with invalid timezone names or dates. Original error: ${errorMessage}`,
          );
        }
      }
    } else {
      this.ms = inDate.getMilliseconds();
      this.second = inDate.getSeconds();
      this.minute = inDate.getMinutes();
      this.hour = inDate.getHours();
      this.day = inDate.getDate();
      this.month = inDate.getMonth();
      this.year = inDate.getFullYear();
    }
  }

  /**
   * Sets internals by deep copying another CronDate
   *
   * @param {CronDate} d - Input date
   */
  private fromCronDate(d: CronDate<T>) {
    this.tz = d.tz;
    this.year = d.year;
    this.month = d.month;
    this.day = d.day;
    this.hour = d.hour;
    this.minute = d.minute;
    this.second = d.second;
    this.ms = d.ms;
  }

  /**
   * Reset internal parameters (seconds, minutes, hours) if any of them have exceeded (or could have exceeded) their normal ranges
   *
   * Will alway return true on february 29th, as that is a date that _could_ be out of bounds
   */
  private apply() {
    // If any value could be out of bounds, apply
    if (
      this.month > 11 || this.month < 0 || this.day > DaysOfMonth[this.month] || this.day < 1 ||
      this.hour > 59 ||
      this.minute > 59 ||
      this.second > 59 || this.hour < 0 || this.minute < 0 || this.second < 0
    ) {
      const d = new Date(
        Date.UTC(this.year, this.month, this.day, this.hour, this.minute, this.second, this.ms),
      );
      this.ms = d.getUTCMilliseconds();
      this.second = d.getUTCSeconds();
      this.minute = d.getUTCMinutes();
      this.hour = d.getUTCHours();
      this.day = d.getUTCDate();
      this.month = d.getUTCMonth();
      this.year = d.getUTCFullYear();
      return true;
    } else {
      return false;
    }
  }

  /**
   * Sets internals by parsing a string
   */
  private fromString(str: string) {
    if (typeof this.tz === "number") {
      // Parse without timezone
      const inDate = fromTZISO(str);
      this.ms = inDate.getUTCMilliseconds();
      this.second = inDate.getUTCSeconds();
      this.minute = inDate.getUTCMinutes();
      this.hour = inDate.getUTCHours();
      this.day = inDate.getUTCDate();
      this.month = inDate.getUTCMonth();
      this.year = inDate.getUTCFullYear();
      this.apply();
    } else {
      return this.fromDate(fromTZISO(str, this.tz));
    }
  }

  /**
   * Internal unified method to find a matching time component in either direction.
   * This method searches through the pattern to find the next or previous valid value
   * for the specified target component (second, minute, hour, day, or month).
   *
   * @param options Cron options
   * @param target Target property (second, minute, hour, day, month)
   * @param pattern Pattern to use
   * @param offset Offset to use
   * @param direction 1 for forward (next), -1 for backward (previous)
   * @returns Status code: 1 = same value matches, 2 = value changed, 3 = no match found
   *
   * @private
   */
  private _findMatch(
    options: CronOptions<T>,
    target: RecursionTarget,
    pattern: CronPattern,
    offset: number,
    direction: 1 | -1,
  ): number {
    const originalTarget = this[target];

    // In the conditions below, local time is not relevant. And as new Date(Date.UTC(y,m,d)) is way faster
    // than new Date(y,m,d). We use the UTC functions to set/get date parts.

    // Pre-calculate last day of month if needed
    let lastDayOfMonth;
    if (pattern.lastDayOfMonth) {
      lastDayOfMonth = this.getLastDayOfMonth(this.year, this.month);
    }

    // Pre-calculate weekday if needed
    // Calculate offset weekday by ((fDomWeekDay + (targetDate - 1)) % 7)
    const fDomWeekDay = (!pattern.starDOW && target == "day")
      ? new Date(Date.UTC(this.year, this.month, 1, 0, 0, 0, 0)).getUTCDay()
      : undefined;

    // Determine loop bounds based on direction
    const startIdx = this[target] + offset;
    const endCondition = direction === 1
      ? (i: number) => i < pattern[target].length
      : (i: number) => i >= 0;

    for (let i = startIdx; endCondition(i); i += direction) {
      // this applies to all "levels"
      let match: number = pattern[target][i];

      // Special case for nearest weekday
      if (target === "day" && !match) {
        // Iterate through all possible 'W' days in the pattern
        for (let dayWithW = 0; dayWithW < pattern.nearestWeekdays.length; dayWithW++) {
          // Check if the pattern specifies the 'W' modifier for this day
          if (pattern.nearestWeekdays[dayWithW]) {
            // Calculate the actual execution day for this 'W' day
            const executionDay = this.getNearestWeekday(this.year, this.month, dayWithW - offset);

            // Skip if the day doesn't exist in this month (executionDay === -1)
            if (executionDay === -1) {
              continue;
            }

            // Check if the day currently being evaluated by the outer loop is that execution day
            if (executionDay === (i - offset)) {
              match = 1;
              break; // Match found, no need to check other 'W' days
            }
          }
        }
      }

      // Special case for last weekday of month
      if (target === "day" && pattern.lastWeekday) {
        const lastWeekday = this.getLastWeekday(this.year, this.month);
        if (i - offset === lastWeekday) {
          match = 1;
        }
      }

      // Special case for last day of month
      if (target === "day" && pattern.lastDayOfMonth && i - offset == lastDayOfMonth) {
        match = 1;
      }

      // Special case for day of week
      if (target === "day" && !pattern.starDOW) {
        let dowMatch = pattern.dayOfWeek[(fDomWeekDay! + ((i - offset) - 1)) % 7];

        // Extra check for nth weekday of month
        // 0b011111 === All occurences of weekday in month
        // 0b100000 === Last occurence of weekday in month
        if (dowMatch && (dowMatch & ANY_OCCURRENCE)) {
          dowMatch = this.isNthWeekdayOfMonth(this.year, this.month, i - offset, dowMatch) ? 1 : 0;
        } else if (dowMatch) {
          throw new Error(`CronDate: Invalid value for dayOfWeek encountered. ${dowMatch}`);
        }

        // OCPS 1.4: If + modifier is used (useAndLogic), always use AND logic
        // Otherwise: If domAndDow is false (legacy OR mode), and dayOfMonth is specified - use "OR" to combine day of week with day of month
        // In all other cases use "AND"
        if (pattern.useAndLogic) {
          match = match && dowMatch;
        } else if (!options.domAndDow && !pattern.starDOM) {
          match = match || dowMatch;
        } else {
          match = match && dowMatch;
        }
      }

      if (match) {
        this[target] = i - offset;

        // Return 2 if changed, 1 if unchanged
        return (originalTarget !== this[target]) ? 2 : 1;
      }
    }

    // Return 3 if part was not matched
    return 3;
  }

  /**
   * Direction-parameterized calendar search core.
   *
   * This single recursive routine replaces the previous parallel forward
   * (`recurse`) and backward (`recurseBackward`) implementations. Both
   * directions walk `RecursionSteps` in the same order and share the
   * component matcher (`_findMatch`); only three things differ, and they are
   * expressed explicitly here:
   *
   *  1. The match search direction (1 forward, -1 backward).
   *  2. How finer components are reset after a coarse component changes:
   *     forward resets to the first candidate (index 0), backward to the
   *     maximum candidate of the freshly entered unit.
   *  3. How the parent component is carried when a level has no match:
   *     `+= direction`, with a guaranteed normalization and restart at the
   *     month level in either direction.
   *
   * Backward search additionally caps the day component after a month/year
   * carry, because setting day 31 before entering February would normalize
   * forward into March and re-enter this routine with a negative level
   * (the historical root cause of the February 29/30 crashes). Forward
   * search never builds such a date: a forward carry enters months at day 1.
   *
   * @param pattern The cron pattern used to determine the run time.
   * @param options The cron options influencing matching.
   * @param doing Index of the `RecursionSteps` entry currently processed.
   * @param direction 1 for forward search, -1 for backward search.
   * @param depth Recursion depth, used only as a safety guard.
   *
   * @returns This `CronDate` for chaining, or null when no match exists
   *          within the supported year range.
   *
   * @private
   */
  private searchMatch(
    pattern: CronPattern,
    options: CronOptions<T>,
    initialDoing: number,
    direction: 1 | -1,
  ): CronDate<T> | null {
    // Iterative state machine. The historical implementations recursed for
    // every component descent, month carry and skipped year. Calendar search
    // only descends five levels, but a constrained pattern with no solution
    // (e.g. "0 0 30 2 *") carries through thousands of years; expressed as
    // recursion that overflowed the native stack in the backward direction.
    // Keeping carries in this loop gives both directions one identical
    // termination mechanism: the supported-year bounds below.
    let doing = initialDoing;
    let iterations = 0;

    while (true) {
      if (++iterations > 1000000) {
        return null;
      }

      // Single termination mechanism for both directions.
      if (direction === 1) {
        if (pattern.starYear ? this.year >= 3000 : this.year >= 10000) {
          return null;
        }
      } else if (this.year < 0) {
        return null;
      }

      // OCPS 1.2: at month level, align directly to the nearest year matching
      // the year pattern, resetting to the start (forward) or end (backward).
      if (doing === 0 && !pattern.starYear) {
        if (this.year >= 0 && this.year < pattern.year.length && pattern.year[this.year] === 0) {
          let foundYear = -1;
          for (let y = this.year + direction; y >= 0 && y < pattern.year.length; y += direction) {
            if (pattern.year[y] === 1) {
              foundYear = y;
              break;
            }
          }
          if (foundYear === -1) {
            return null;
          }
          this.year = foundYear;
          if (direction === 1) {
            this.month = 0;
            this.day = 1;
            this.hour = 0;
            this.minute = 0;
            this.second = 0;
          } else {
            this.month = 11;
            this.day = 31;
            this.hour = 23;
            this.minute = 59;
            this.second = 59;
          }
          this.ms = 0;
        }
        if (direction === 1 ? this.year >= 10000 : this.year < 0) {
          return null;
        }
      }

      const res = this._findMatch(
        options,
        RecursionSteps[doing][0],
        pattern,
        RecursionSteps[doing][2],
        direction,
      );

      if (res > 1) {
        // Reset finer components: first candidate forward, maximum candidate
        // backward within the entered unit.
        let resetLevel = doing + 1;
        while (resetLevel < RecursionSteps.length) {
          const resetTarget = RecursionSteps[resetLevel][0];
          const resetOffset = RecursionSteps[resetLevel][2];
          if (direction === 1) {
            this[resetTarget] = -resetOffset;
          } else {
            this[resetTarget] = this.getMaxPatternValue(resetTarget, pattern, resetOffset);
          }
          resetLevel++;
        }

        if (res === 3) {
          // No match in this unit: carry the parent.
          if (direction === 1) {
            this[RecursionSteps[doing][0]] = -RecursionSteps[doing][2];
            this[RecursionSteps[doing][1]]++;
            // Normalize before rescanning: a day carry out of a constrained
            // month (e.g. last day of February) has to roll forward so the
            // month-level rescan skips the entered, unconstrained month.
            this.apply();

            if (doing === 0 && !pattern.starYear) {
              while (
                this.year >= 0 &&
                this.year < pattern.year.length &&
                pattern.year[this.year] === 0 &&
                this.year < 10000
              ) {
                this.year++;
              }
              if (this.year >= 10000 || this.year >= pattern.year.length) {
                return null;
              }
            }

            // Every forward carry restarts at month level. A day/hour carry
            // out of a constrained month must rescan months (L constrained
            // to February must not settle on March 31); finer carries
            // restarting at month level simply re-match the unchanged
            // coarse components at cost of a few comparisons.
            doing = 0;
            continue;
          }

          // Backward carry: decrement parent, normalize, then preload current
          // and finer levels with maxima computed for the entered unit.
          this[RecursionSteps[doing][1]]--;
          if (doing <= 1) {
            this.clampDayToCurrentMonth();
          }
          this.apply();

          let backwardReset = doing;
          while (backwardReset < RecursionSteps.length) {
            const resetTarget = RecursionSteps[backwardReset][0];
            const resetOffset = RecursionSteps[backwardReset][2];
            let maxValue = this.getMaxPatternValue(resetTarget, pattern, resetOffset);
            if (resetTarget === "day") {
              maxValue = Math.min(maxValue, this.getLastDayOfMonth(this.year, this.month));
            }
            this[resetTarget] = maxValue;
            backwardReset++;
          }
          this.apply();

          if (doing === 0 && !pattern.starYear) {
            while (
              this.year >= 0 &&
              this.year < pattern.year.length &&
              pattern.year[this.year] === 0
            ) {
              this.year--;
            }
            if (this.year < 0) {
              return null;
            }
          }

          doing = 0;
          continue;
        }

        // res === 2: the value at this level changed.
        if (direction === 1) {
          // Forward normalization crosses December/January via the month
          // matcher at level -1, and finer overflows via the parent level.
          if (this.apply()) {
            doing = doing - 1;
            continue;
          }
        } else if (this.apply()) {
          // Backward normalization crossed a boundary.
          if (doing === 0) {
            // Month match landed while an over-long day was attached (only
            // possible entering a month with fewer days than the preloaded
            // candidate). Clamp to the end of the entered month and let the
            // day matcher decide below, instead of dropping the whole year.
            this.clampDayToCurrentMonth();
            this.apply();
          } else if (doing === 1) {
            // The day matcher selected a pattern day that does not exist in
            // this month (February 29 in a non-leap year, or an impossible
            // day such as February 30). Normalization rolled forward into
            // the following month, which the day search already ruled out.
            // Carry one month backward while keeping the over-long candidate:
            // an intermediate month then fails its day search and the
            // res === 3 carry reaches February of the previous year, where a
            // leap day matches. This was the historical February 29/30
            // crash site in the parallel backward implementation.
            this.month--;
            if (this.month < 0) {
              this.month = 11;
              this.year--;
              if (!pattern.starYear) {
                while (
                  this.year >= 0 &&
                  this.year < pattern.year.length &&
                  pattern.year[this.year] === 0
                ) {
                  this.year--;
                }
              }
              if (this.year < 0) {
                return null;
              }
            }
            doing = 0;
            continue;
          } else {
            doing = doing - 1;
            continue;
          }
        }
      }

      // Descend one level, or finish when every component matched.
      doing += 1;
      if (doing >= RecursionSteps.length) {
        return this;
      }
    }
  }

  /**
   * Cap the current day at the last day of the current month/year. Used by
   * backward search after a month or year carry, where finer components were
   * preloaded with pattern maxima (e.g. day 31 or a leap-day pattern) that
   * may not exist in the entered month.
   *
   * @private
   */
  private clampDayToCurrentMonth(): void {
    const lastDayOfMonth = this.getLastDayOfMonth(this.year, this.month);
    if (this.day > lastDayOfMonth) {
      this.day = lastDayOfMonth;
    }
  }

  /**
   * Increment to next run time.
   *
   * Thin entry wrapper around the direction-parameterized search core.
   *
   * @param pattern The pattern used to increment the current date.
   * @param options Cron options used for incrementing.
   * @param hasPreviousRun True if there was a previous run, false otherwise. This is used to determine whether to apply the minimum interval.
   * @returns This CronDate instance for chaining, or null when no match exists in the supported year range.
   */
  public increment(
    pattern: CronPattern,
    options: CronOptions<T>,
    hasPreviousRun: boolean,
  ): CronDate<T> | null {
    // Move to next second, or increment according to minimum interval indicated by option `interval: x`
    // Do not increment a full interval if this is the very first run
    this.second += (options.interval !== undefined && options.interval > 1 && hasPreviousRun)
      ? options.interval
      : 1;

    // Always reset milliseconds, so we are at the next second exactly
    this.ms = 0;

    // Make sure seconds has not gotten out of bounds
    this.apply();

    // Recursively change each part (y, m, d ...) until next match is found, return null on failure
    return this.searchMatch(pattern, options, 0, 1);
  }

  /**
   * Decrement to previous run time.
   *
   * Backward counterpart of {@link increment}, using the same search core
   * with direction -1. The minimum interval is applied whenever configured,
   * matching the previous parallel implementation.
   *
   * @param pattern The pattern used to decrement the current date.
   * @param options Cron options used for decrementing.
   * @returns This CronDate instance for chaining, or null when no match exists in the supported year range.
   */
  public decrement(
    pattern: CronPattern,
    options: CronOptions<T>,
  ): CronDate<T> | null {
    // Move to previous second, or decrement according to minimum interval indicated by option `interval: x`
    this.second -= (options.interval !== undefined && options.interval > 1) ? options.interval : 1;

    // Always reset milliseconds, so we are at the exact second
    this.ms = 0;

    // Make sure seconds has not gotten out of bounds (can be negative)
    this.apply();

    // Recursively change each part (y, m, d ...) until previous match is found, return null on failure
    return this.searchMatch(pattern, options, 0, -1);
  }

  /**
   * Get the maximum value in a pattern for a given target.
   * Used when resetting components during backward recursion.
   *
   * @param target The target component (second, minute, hour, day, month)
   * @param pattern The cron pattern
   * @param offset The offset to apply
   * @returns The maximum valid value for the target component
   *
   * @private
   */
  private getMaxPatternValue(
    target: RecursionTarget,
    pattern: CronPattern,
    offset: number,
  ): number {
    // Special handling for day when lastDayOfMonth is set
    if (target === "day" && pattern.lastDayOfMonth) {
      // Return the actual last day of the current month
      return this.getLastDayOfMonth(this.year, this.month);
    }

    // Special handling for day with day-of-week patterns
    if (target === "day" && !pattern.starDOW) {
      // Get the actual last day of the current month as we need to check all days
      const lastDay = this.getLastDayOfMonth(this.year, this.month);
      return lastDay;
    }

    // Find the highest value in the pattern array that equals 1
    for (let i = pattern[target].length - 1; i >= 0; i--) {
      if (pattern[target][i]) {
        return i - offset;
      }
    }

    // Fallback: return the pattern length minus offset
    // This ensures we at least try searching from a reasonable upper bound
    return pattern[target].length - 1 - offset;
  }

  /**
   * Convert current state back to a javascript Date()
   *
   * @param internal If this is an internal call
   */
  public getDate(internal?: boolean): Date {
    // If this is an internal call, return the date as is
    // Also use this option when no timezone or utcOffset is set
    if (internal || this.tz === void 0) {
      return new Date(
        this.year,
        this.month,
        this.day,
        this.hour,
        this.minute,
        this.second,
        this.ms,
      );
    } else {
      // If .tz is a number, it indicates offset in minutes. UTC timestamp of the internal date objects will be off by the same number of minutes.
      // Restore this, and return a date object with correct time set.
      if (typeof this.tz === "number") {
        return new Date(
          Date.UTC(
            this.year,
            this.month,
            this.day,
            this.hour,
            this.minute - this.tz,
            this.second,
            this.ms,
          ),
        );

        // If .tz is something else (hopefully a string), it indicates the timezone of the "local time" of the internal date object
        // Use timezone utilities to create a normal Date object, and return that.
      } else {
        // Explicit DST transition guard: resolve the nominal local wall time
        // to a real UTC instant. Non-existent local times map to the first
        // instant after the gap, and repeated local times resolve to their
        // first occurrence. Both decisions are recorded on this instance.
        const resolved = resolveLocalTime(
          this.year,
          this.month + 1,
          this.day,
          this.hour,
          this.minute,
          this.second,
          this.tz,
        );
        this.lastDstKind = resolved.kind;
        return resolved.instant;
      }
    }
  }

  /**
   * Convert current state back to a javascript Date() and return UTC milliseconds
   */
  public getTime(): number {
    return this.getDate(false).getTime();
  }

  /**
   * Check if the current CronDate matches a cron pattern
   *
   * @param pattern The cron pattern to match against
   * @param options The cron options that influence matching
   * @returns true if the date matches the pattern, false otherwise
   */
  public match(pattern: CronPattern, options: CronOptions<T>): boolean {
    // Check year if year constraints exist
    if (!pattern.starYear) {
      if (
        this.year < 0 ||
        this.year >= pattern.year.length ||
        pattern.year[this.year] === 0
      ) {
        return false;
      }
    }

    // Check each component using the existing findNext logic
    // by checking if each component at its current value matches
    for (let doing = 0; doing < RecursionSteps.length; doing++) {
      const target = RecursionSteps[doing][0];
      const offset = RecursionSteps[doing][2];
      const targetValue = this[target];

      // Check if the current value is within bounds
      if (targetValue + offset < 0 || targetValue + offset >= pattern[target].length) {
        return false;
      }

      let match: number = pattern[target][targetValue + offset];

      // Apply the same special cases as in findNext
      if (target === "day") {
        // Special case for nearest weekday (W modifier)
        if (!match) {
          for (let dayWithW = 0; dayWithW < pattern.nearestWeekdays.length; dayWithW++) {
            if (pattern.nearestWeekdays[dayWithW]) {
              const executionDay = this.getNearestWeekday(this.year, this.month, dayWithW - offset);
              // Skip if the day doesn't exist in this month
              if (executionDay !== -1 && executionDay === targetValue) {
                match = 1;
                break;
              }
            }
          }
        }

        // Special case for last weekday of month (LW modifier)
        if (pattern.lastWeekday) {
          const lastWeekday = this.getLastWeekday(this.year, this.month);
          if (targetValue === lastWeekday) {
            match = 1;
          }
        }

        // Special case for last day of month (L modifier)
        if (pattern.lastDayOfMonth) {
          const lastDayOfMonth = this.getLastDayOfMonth(this.year, this.month);
          if (targetValue === lastDayOfMonth) {
            match = 1;
          }
        }

        // Special case for day of week
        if (!pattern.starDOW) {
          const fDomWeekDay = new Date(Date.UTC(this.year, this.month, 1, 0, 0, 0, 0)).getUTCDay();
          let dowMatch = pattern.dayOfWeek[(fDomWeekDay + (targetValue - 1)) % 7];

          // Extra check for nth weekday of month
          if (dowMatch && (dowMatch & ANY_OCCURRENCE)) {
            dowMatch = this.isNthWeekdayOfMonth(this.year, this.month, targetValue, dowMatch)
              ? 1
              : 0;
          }

          // Apply same logic as in findNext for combining day of month and day of week
          if (pattern.useAndLogic) {
            match = match && dowMatch;
          } else if (!options.domAndDow && !pattern.starDOM) {
            match = match || dowMatch;
          } else {
            match = match && dowMatch;
          }
        }
      }

      // If this component doesn't match, the date doesn't match the pattern
      if (!match) {
        return false;
      }
    }

    // All components matched
    return true;
  }
}

export { CronDate };
