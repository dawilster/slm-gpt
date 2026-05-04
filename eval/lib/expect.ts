/**
 * Tiny matcher library. Throws ExpectationError on mismatch — the runner
 * catches that and surfaces the .message as the case's detail.
 *
 * We intentionally don't reach for jest/chai. The eval suites only need a
 * handful of matchers and the dependency cost is real on a Bun project.
 */

export class ExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectationError";
  }
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 80 ? v.slice(0, 77) + "…" : v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

class Expectation<T> {
  constructor(private readonly actual: T, private readonly negated = false) {}
  get not(): Expectation<T> { return new Expectation(this.actual, !this.negated); }

  private check(condition: boolean, msg: string): void {
    const fail = this.negated ? condition : !condition;
    if (fail) throw new ExpectationError(this.negated ? `not: ${msg}` : msg);
  }

  toBe(expected: T): void {
    this.check(this.actual === expected, `expected ${fmt(this.actual)} === ${fmt(expected)}`);
  }
  toEqual(expected: unknown): void {
    const a = JSON.stringify(this.actual);
    const b = JSON.stringify(expected);
    this.check(a === b, `expected ${a} to deep-equal ${b}`);
  }
  toBeTruthy(): void { this.check(Boolean(this.actual), `expected ${fmt(this.actual)} to be truthy`); }
  toBeFalsy(): void  { this.check(!this.actual,         `expected ${fmt(this.actual)} to be falsy`); }
  toBeNull(): void   { this.check(this.actual === null, `expected ${fmt(this.actual)} to be null`); }
  toBeDefined(): void { this.check(this.actual !== undefined, `expected value to be defined`); }
  toBeUndefined(): void { this.check(this.actual === undefined, `expected ${fmt(this.actual)} to be undefined`); }

  toBeGreaterThan(n: number): void {
    this.check(typeof this.actual === "number" && this.actual > n, `expected ${fmt(this.actual)} > ${n}`);
  }
  toBeGreaterThanOrEqual(n: number): void {
    this.check(typeof this.actual === "number" && this.actual >= n, `expected ${fmt(this.actual)} >= ${n}`);
  }
  toBeLessThan(n: number): void {
    this.check(typeof this.actual === "number" && this.actual < n, `expected ${fmt(this.actual)} < ${n}`);
  }
  toBeLessThanOrEqual(n: number): void {
    this.check(typeof this.actual === "number" && this.actual <= n, `expected ${fmt(this.actual)} <= ${n}`);
  }

  toMatch(re: RegExp): void {
    if (typeof this.actual !== "string") {
      throw new ExpectationError(`toMatch expects a string, got ${typeof this.actual}`);
    }
    this.check(re.test(this.actual), `expected ${fmt(this.actual)} to match ${re}`);
  }
  toContain(needle: unknown): void {
    const a = this.actual as unknown;
    if (typeof a === "string") {
      this.check(a.includes(needle as string), `expected ${fmt(a)} to contain ${fmt(needle)}`);
    } else if (Array.isArray(a)) {
      this.check(a.includes(needle), `expected ${fmt(a)} to contain ${fmt(needle)}`);
    } else {
      throw new ExpectationError(`toContain only works on strings or arrays`);
    }
  }
  toStartWith(prefix: string): void {
    if (typeof this.actual !== "string") throw new ExpectationError("toStartWith expects a string");
    this.check(this.actual.startsWith(prefix), `expected ${fmt(this.actual)} to start with ${fmt(prefix)}`);
  }
  toHaveLength(n: number): void {
    const len = (this.actual as { length?: unknown })?.length;
    this.check(len === n, `expected length ${len} to be ${n}`);
  }

  /** True when the array contains every element listed (order-independent). */
  toIncludeAll(items: readonly unknown[]): void {
    if (!Array.isArray(this.actual)) throw new ExpectationError("toIncludeAll expects an array");
    const missing = items.filter((x) => !this.actual.includes(x));
    this.check(missing.length === 0, `expected ${fmt(this.actual)} to include all of ${fmt(items)} (missing ${fmt(missing)})`);
  }
}

export function expect<T>(actual: T): Expectation<T> {
  return new Expectation<T>(actual);
}

/** Manual assertion when the matcher API would be awkward. */
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ExpectationError(msg);
}

/** Treat-as-pass with a detail string. Useful inside a scenario judge to
 *  surface why something passed (e.g. "tools=[a,b]"). */
export function pass(detail: string): { detail: string } { return { detail }; }
