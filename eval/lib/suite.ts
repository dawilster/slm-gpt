/**
 * Eval DSL — RSpec-inspired, with one extra primitive (`scenario`) for the
 * stochastic threshold-based checks that an LLM eval needs.
 *
 *   describe("...", () => { ... })  — nested grouping
 *   it("...", async () => { ... })  — single deterministic check
 *   scenario("...", { ... })        — k-of-n threshold check across prompts
 *   beforeAll / afterAll            — hooks at any describe level
 *   info("...", async () => { ... })— informational only, never gates
 *
 * Suites register themselves at module load time. The runner imports each
 * suite file then walks the registered tree. There is no hidden state shared
 * between suites — each suite is its own root.
 */
import { ExpectationError } from "./expect";

export type Hook = () => Promise<void> | void;

export type JudgeContext<T = unknown> = {
  prompt: string;
  index: number;
  /** Free-form bag the suite can stash data on (e.g. a workspace handle). */
  fixtures: T;
};

export type JudgeOutcome = void | string | { detail?: string };

export type ScenarioSpec<T = unknown> = {
  /** [pass count, total]. Null marks the scenario informational — runs and
   *  reports, but never contributes to the exit code. */
  threshold: [number, number] | null;
  prompts: readonly string[];
  judge: (ctx: JudgeContext<T>) => Promise<JudgeOutcome> | JudgeOutcome;
  /** Overrides the run's offline policy if set — true means "needs the model
   *  server", false means "pure logic, run even with --offline". Defaults to
   *  true since most scenarios use the LLM. */
  needsModel?: boolean;
};

export type TestCase =
  | { kind: "it";       name: string; fn: () => Promise<JudgeOutcome> | JudgeOutcome; needsModel: boolean; informational: boolean }
  | { kind: "scenario"; name: string; spec: ScenarioSpec<any>; informational: boolean };

export type SuiteNode = {
  name: string;
  parent: SuiteNode | null;
  children: SuiteNode[];
  beforeAlls: Hook[];
  afterAlls: Hook[];
  cases: TestCase[];
};

const ROOTS: SuiteNode[] = [];
let CURRENT: SuiteNode | null = null;

function newNode(name: string, parent: SuiteNode | null): SuiteNode {
  return { name, parent, children: [], beforeAlls: [], afterAlls: [], cases: [] };
}

export function describe(name: string, body: () => void): void {
  const parent = CURRENT;
  const node = newNode(name, parent);
  if (parent) parent.children.push(node);
  else ROOTS.push(node);
  CURRENT = node;
  try { body(); }
  finally { CURRENT = parent; }
}

function ensureCurrent(api: string): SuiteNode {
  if (!CURRENT) throw new Error(`${api}() must be called inside describe()`);
  return CURRENT;
}

export function beforeAll(fn: Hook): void { ensureCurrent("beforeAll").beforeAlls.push(fn); }
export function afterAll(fn: Hook): void  { ensureCurrent("afterAll").afterAlls.push(fn); }

export function it(
  name: string,
  fn: () => Promise<JudgeOutcome> | JudgeOutcome,
  opts: { needsModel?: boolean; informational?: boolean } = {},
): void {
  ensureCurrent("it").cases.push({
    kind: "it",
    name,
    fn,
    needsModel: opts.needsModel ?? false,
    informational: opts.informational ?? false,
  });
}

export function scenario<T = unknown>(name: string, spec: ScenarioSpec<T>): void {
  ensureCurrent("scenario").cases.push({
    kind: "scenario",
    name,
    spec: spec as ScenarioSpec<unknown>,
    informational: spec.threshold === null,
  });
}

/** Like `it`, but never contributes to the exit code. Use for cases that are
 *  inherently ambiguous (v5's profile-vs-history override). */
export function info(name: string, fn: () => Promise<JudgeOutcome> | JudgeOutcome): void {
  it(name, fn, { informational: true });
}

export function registeredSuites(): readonly SuiteNode[] { return ROOTS; }

/** Used by tests of the framework itself. Production runs never call this. */
export function _resetRegistry(): void { ROOTS.length = 0; CURRENT = null; }

// ─── Reporter contract ─────────────────────────────────────────

export type CaseResult =
  | { kind: "it"; passed: boolean; detail?: string; durationMs: number; informational: boolean }
  | {
      kind: "scenario";
      passed: boolean;            // threshold met (or informational)
      informational: boolean;
      passCount: number;
      totalCount: number;
      threshold: [number, number] | null;
      rows: Array<{ prompt: string; passed: boolean; detail?: string; durationMs: number }>;
      durationMs: number;
    };

export type SuiteRunResult = {
  name: string;
  path: string[];
  cases: Array<{ name: string; result: CaseResult }>;
  childSuites: SuiteRunResult[];
};

// ─── Runner ────────────────────────────────────────────────────

export type RunOptions = {
  offline: boolean;
  /** Filter: only run a top-level suite whose name matches. */
  only?: string;
  /** Fired when a describe-block starts (root suite first, then nested). */
  onSuiteStart?: (path: string[], name: string) => void;
  /** Per-case progress reporter. */
  onCaseStart?: (path: string[], caseName: string) => void;
  onCaseEnd?: (path: string[], caseName: string, result: CaseResult) => void;
  /** Per-prompt progress within a scenario. */
  onPromptEnd?: (
    path: string[],
    scenarioName: string,
    row: { prompt: string; passed: boolean; detail?: string; durationMs: number },
  ) => void;
};

async function runHooks(hooks: Hook[]): Promise<void> {
  for (const h of hooks) await h();
}

async function runIt(
  c: Extract<TestCase, { kind: "it" }>,
  offline: boolean,
): Promise<CaseResult> {
  if (offline && c.needsModel) {
    return { kind: "it", passed: true, detail: "skipped (offline)", durationMs: 0, informational: true };
  }
  const t0 = Date.now();
  try {
    const out = await c.fn();
    let detail: string | undefined;
    if (typeof out === "string") detail = out;
    else if (out && typeof out === "object" && "detail" in out) detail = out.detail;
    return { kind: "it", passed: true, detail, durationMs: Date.now() - t0, informational: c.informational };
  } catch (e: any) {
    const detail = e instanceof ExpectationError ? e.message : (e?.message ?? String(e));
    return { kind: "it", passed: false, detail, durationMs: Date.now() - t0, informational: c.informational };
  }
}

async function runScenario(
  c: Extract<TestCase, { kind: "scenario" }>,
  offline: boolean,
  reportPrompt?: (row: { prompt: string; passed: boolean; detail?: string; durationMs: number }) => void,
): Promise<CaseResult> {
  const needsModel = c.spec.needsModel ?? true;
  if (offline && needsModel) {
    return {
      kind: "scenario",
      passed: true,
      informational: true,
      passCount: 0,
      totalCount: c.spec.prompts.length,
      threshold: c.spec.threshold,
      rows: [],
      durationMs: 0,
    };
  }

  const t0 = Date.now();
  const rows: Array<{ prompt: string; passed: boolean; detail?: string; durationMs: number }> = [];
  let passCount = 0;
  for (let i = 0; i < c.spec.prompts.length; i++) {
    const prompt = c.spec.prompts[i]!;
    const tc0 = Date.now();
    let passed = false;
    let detail: string | undefined;
    try {
      const out = await c.spec.judge({ prompt, index: i, fixtures: undefined as never });
      passed = true;
      if (typeof out === "string") detail = out;
      else if (out && typeof out === "object" && "detail" in out) detail = out.detail;
    } catch (e: any) {
      passed = false;
      detail = e instanceof ExpectationError ? e.message : (e?.message ?? String(e));
    }
    const row = { prompt, passed, detail, durationMs: Date.now() - tc0 };
    rows.push(row);
    if (passed) passCount++;
    reportPrompt?.(row);
  }
  const total = c.spec.prompts.length;
  const thresholdHit = c.spec.threshold === null || passCount >= c.spec.threshold[0];
  return {
    kind: "scenario",
    passed: thresholdHit,
    informational: c.informational,
    passCount,
    totalCount: total,
    threshold: c.spec.threshold,
    rows,
    durationMs: Date.now() - t0,
  };
}

export async function runNode(node: SuiteNode, path: string[], opts: RunOptions): Promise<SuiteRunResult> {
  const here = [...path, node.name];
  opts.onSuiteStart?.(here, node.name);
  await runHooks(node.beforeAlls);
  const out: SuiteRunResult = { name: node.name, path: here, cases: [], childSuites: [] };
  try {
    for (const c of node.cases) {
      opts.onCaseStart?.(here, c.name);
      let result: CaseResult;
      if (c.kind === "it") {
        result = await runIt(c, opts.offline);
      } else {
        result = await runScenario(c, opts.offline, (row) => opts.onPromptEnd?.(here, c.name, row));
      }
      out.cases.push({ name: c.name, result });
      opts.onCaseEnd?.(here, c.name, result);
    }
    for (const child of node.children) {
      out.childSuites.push(await runNode(child, here, opts));
    }
  } finally {
    await runHooks(node.afterAlls);
  }
  return out;
}

export async function runAll(opts: RunOptions): Promise<SuiteRunResult[]> {
  const out: SuiteRunResult[] = [];
  for (const root of ROOTS) {
    if (opts.only && root.name !== opts.only && !root.name.startsWith(opts.only)) continue;
    out.push(await runNode(root, [], opts));
  }
  return out;
}
