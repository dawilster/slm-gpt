/**
 * Reusable judge helpers — each suite wires its own logic, but these are
 * the recurring shapes. They all return `{ detail }` on success or throw
 * an ExpectationError so the runner can surface a clean failure message.
 */

import { ExpectationError } from "./expect";
import type { ObservedCall } from "./fixtures";

/** Pass if `name` was called; detail lists everything that was called. */
export function calledTool(calls: ObservedCall[], name: string): { detail: string } {
  const names = calls.map((c) => c.name);
  if (!names.includes(name)) {
    throw new ExpectationError(`expected ${name} to be called; got [${names.join(",") || "(none)"}]`);
  }
  return { detail: `tools=[${names.join(",")}]` };
}

/** Pass if NO tool was called. */
export function calledNothing(calls: ObservedCall[]): { detail: string } {
  if (calls.length > 0) {
    throw new ExpectationError(`expected no tool call; got [${calls.map((c) => c.name).join(",")}]`);
  }
  return { detail: "no tool called" };
}

/** Pass if `name` was called AND the named arg matches `argRe`. */
export function calledToolWithArg(
  calls: ObservedCall[],
  name: string,
  argName: string,
  argRe: RegExp,
): { detail: string } {
  const match = calls.find((c) => c.name === name);
  if (!match) {
    throw new ExpectationError(`expected ${name} to be called; got [${calls.map((c) => c.name).join(",") || "(none)"}]`);
  }
  const v = match.args[argName];
  const s = v == null ? "" : String(v);
  if (!argRe.test(s)) {
    throw new ExpectationError(`${name}.${argName}=${JSON.stringify(s)} did not match ${argRe}`);
  }
  return { detail: `${name}(${argName}=${JSON.stringify(s).slice(0, 60)})` };
}

/** Pass if any of the named tools' results match `re`. */
export function toolResultMatches(
  calls: ObservedCall[],
  toolNames: readonly string[],
  re: RegExp,
): { detail: string } {
  const matching = calls.filter((c) => toolNames.includes(c.name));
  if (matching.length === 0) {
    throw new ExpectationError(`no calls to ${toolNames.join("/")} (had [${calls.map((c) => c.name).join(",") || "(none)"}])`);
  }
  const hit = matching.some((c) => re.test(c.result));
  if (!hit) {
    throw new ExpectationError(`results from ${toolNames.join("/")} did not match ${re}`);
  }
  return { detail: `tools=[${calls.map((c) => c.name).join(",")}]` };
}

/** Pass if `reply` matches `re`. */
export function replyMatches(reply: string, re: RegExp): { detail: string } {
  if (!re.test(reply)) {
    throw new ExpectationError(`reply did not match ${re}: "${reply.replace(/\n/g, " ").slice(0, 80)}"`);
  }
  return { detail: `reply: "${reply.replace(/\n/g, " ").slice(0, 60)}"` };
}
