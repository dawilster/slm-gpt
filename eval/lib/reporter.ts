/**
 * Pretty-printer for SuiteRunResult. Aims to read like an RSpec run:
 *   suites in bold, describes indented, scenarios with k/n vs threshold,
 *   per-prompt rows on each line. Terminal colours via ANSI; degrade to
 *   plain when stdout isn't a TTY.
 */

import type { CaseResult, SuiteRunResult } from "./suite";

const isTTY = !!process.stdout.isTTY;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  dim:   isTTY ? "\x1b[2m" : "",
  bold:  isTTY ? "\x1b[1m" : "",
  red:   isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow:isTTY ? "\x1b[33m" : "",
  blue:  isTTY ? "\x1b[34m" : "",
  cyan:  isTTY ? "\x1b[36m" : "",
};

function mark(passed: boolean, informational = false): string {
  if (informational) return `${c.dim}—${c.reset}`;
  return passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
}

function indent(depth: number): string { return "  ".repeat(depth); }

export function printSuiteHeader(name: string): void {
  console.log(`\n${c.bold}═══ ${name} ${"═".repeat(Math.max(3, 60 - name.length))}${c.reset}`);
}

export function printCaseStart(_path: string[], _name: string): void {
  // intentionally quiet — final result is printed on completion
}

export function printCaseResult(path: string[], name: string, result: CaseResult): void {
  const depth = Math.max(0, path.length - 1);
  const pad = indent(depth + 1);
  if (result.kind === "it") {
    console.log(`${pad}${mark(result.passed, result.informational)} ${name}${result.detail ? ` ${c.dim}— ${result.detail}${c.reset}` : ""}`);
    return;
  }
  // scenario
  const t = result.threshold;
  const ratio = `${result.passCount}/${result.totalCount}`;
  const need = t ? `≥${t[0]}/${t[1]}` : "info";
  const m = result.informational ? mark(false, true) : mark(result.passed);
  const tag = result.informational ? c.dim + "(info)" + c.reset : "";
  console.log(`${pad}${m} ${c.bold}${name}${c.reset} ${c.dim}(${ratio}, ${need})${c.reset} ${tag}`);
}

export function printPromptRow(
  path: string[],
  _scenario: string,
  row: { prompt: string; passed: boolean; detail?: string; durationMs: number },
): void {
  const depth = Math.max(0, path.length - 1);
  const pad = indent(depth + 2);
  const promptShort = row.prompt.length > 55 ? row.prompt.slice(0, 52) + "…" : row.prompt;
  const detail = row.detail ? ` ${c.dim}— ${row.detail.replace(/\n/g, " ").slice(0, 90)}${c.reset}` : "";
  console.log(`${pad}${mark(row.passed)} "${promptShort}"${detail}`);
}

export function printDescribeStart(path: string[], name: string): void {
  if (path.length === 1) {
    printSuiteHeader(name);
  } else {
    const depth = path.length - 1;
    console.log(`${indent(depth)}${c.cyan}§ ${name}${c.reset}`);
  }
}

// ─── summary ──────────────────────────────────────────────────

type Tally = { gatedTotal: number; gatedPassed: number; informational: number; informationalFails: number };

function tallyCase(t: Tally, r: CaseResult): void {
  if (r.informational) {
    t.informational++;
    if (!r.passed) t.informationalFails++;
    return;
  }
  t.gatedTotal++;
  if (r.passed) t.gatedPassed++;
}

function walk(t: Tally, sr: SuiteRunResult, fails: Array<{ path: string[]; name: string; result: CaseResult }>): void {
  for (const c of sr.cases) {
    tallyCase(t, c.result);
    if (!c.result.passed && !c.result.informational) {
      fails.push({ path: sr.path, name: c.name, result: c.result });
    }
  }
  for (const child of sr.childSuites) walk(t, child, fails);
}

export function printSummary(results: SuiteRunResult[]): { allPassed: boolean } {
  const tally: Tally = { gatedTotal: 0, gatedPassed: 0, informational: 0, informationalFails: 0 };
  const fails: Array<{ path: string[]; name: string; result: CaseResult }> = [];
  for (const sr of results) walk(tally, sr, fails);

  console.log(`\n${c.bold}═══ summary ${"═".repeat(50)}${c.reset}`);

  // Per-suite line so you can eyeball which suites are healthy.
  for (const sr of results) {
    const subTally: Tally = { gatedTotal: 0, gatedPassed: 0, informational: 0, informationalFails: 0 };
    walk(subTally, sr, []);
    const ok = subTally.gatedPassed === subTally.gatedTotal;
    const m = mark(ok);
    const ratio = `${subTally.gatedPassed}/${subTally.gatedTotal}`;
    const info = subTally.informational > 0 ? ` ${c.dim}(+${subTally.informational} info)${c.reset}` : "";
    console.log(`  ${m} ${sr.name.padEnd(18)} ${c.dim}${ratio}${c.reset}${info}`);
  }

  console.log(`\n  total gated: ${tally.gatedPassed}/${tally.gatedTotal}`);
  if (tally.informational > 0) {
    console.log(`  ${c.dim}informational: ${tally.informational - tally.informationalFails}/${tally.informational} (no gating)${c.reset}`);
  }

  const allPassed = tally.gatedPassed === tally.gatedTotal;
  if (!allPassed) {
    console.log(`\n${c.red}${c.bold}failures:${c.reset}`);
    for (const f of fails) {
      const where = f.path.join(" › ");
      const r = f.result;
      if (r.kind === "it") {
        console.log(`  ${c.red}✗${c.reset} ${where} › ${f.name}${r.detail ? `\n      ${c.dim}${r.detail}${c.reset}` : ""}`);
      } else {
        const t = r.threshold;
        console.log(`  ${c.red}✗${c.reset} ${where} › ${f.name} ${c.dim}(${r.passCount}/${r.totalCount}, need ≥${t?.[0]}/${t?.[1]})${c.reset}`);
        for (const row of r.rows.filter((x) => !x.passed)) {
          console.log(`      ${c.dim}- "${row.prompt.slice(0, 70)}" ${row.detail ? `→ ${row.detail.slice(0, 80)}` : ""}${c.reset}`);
        }
      }
    }
  } else {
    console.log(`\n${c.green}${c.bold}all gated checks passed${c.reset}`);
  }
  return { allPassed };
}
