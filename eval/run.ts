#!/usr/bin/env bun
/**
 * Eval runner.
 *
 * Usage:
 *   bun run eval/run.ts                  # run every suite
 *   bun run eval/run.ts shortcuts        # run one suite by name (prefix match)
 *   bun run eval/run.ts --offline        # skip anything that hits the model
 *   bun run eval/run.ts shortcuts --offline
 *
 * Exits 0 only when every gated check passes. Informational checks never
 * gate. See eval/lib/suite.ts for the DSL.
 */

import { runAll, registeredSuites } from "./lib/suite";
import {
  printDescribeStart,
  printCaseStart,
  printCaseResult,
  printPromptRow,
  printSummary,
} from "./lib/reporter";

// Order matters: cheaper / no-model suites first so a misconfigured server
// fails fast on the meaningful tests.
import "./suites/substrate";
import "./suites/context";
import "./suites/persistence";
import "./suites/profile";
import "./suites/tool_loop";
import "./suites/rag";
import "./suites/shortcuts";

function parseArgs(argv: string[]): { only?: string; offline: boolean; help: boolean } {
  const args = argv.slice(2);
  let only: string | undefined;
  let offline = false;
  let help = false;
  for (const a of args) {
    if (a === "--offline") offline = true;
    else if (a === "-h" || a === "--help") help = true;
    else if (!a.startsWith("-")) only = a;
  }
  return { only, offline, help };
}

function printHelp(): void {
  const names = registeredSuites().map((s) => s.name).join(", ");
  console.log(`Usage: bun run eval/run.ts [suite] [--offline]

Suites: ${names}
  --offline   skip model-driven checks (still runs unit/fuzzy tests)`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }

  const found = opts.only
    ? registeredSuites().find((s) => s.name === opts.only || s.name.startsWith(opts.only!))
    : null;
  if (opts.only && !found) {
    console.error(`unknown suite "${opts.only}". Available: ${registeredSuites().map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  const results = await runAll({
    offline: opts.offline,
    only: opts.only,
    onSuiteStart: (path, name) => printDescribeStart(path, name),
    onCaseStart: printCaseStart,
    onCaseEnd: printCaseResult,
    onPromptEnd: printPromptRow,
  });

  const { allPassed } = printSummary(results);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("\nrunner crashed:", e?.stack ?? e);
  process.exit(2);
});
