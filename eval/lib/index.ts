/** Convenience barrel — suites can `import { ... } from "../lib"` instead of
 *  reaching into individual files. Optional; named imports also work fine. */

export { describe, it, scenario, info, beforeAll, afterAll } from "./suite";
export type { ScenarioSpec, JudgeContext, JudgeOutcome } from "./suite";
export { expect, assert, pass, ExpectationError } from "./expect";
export {
  Workspace,
  BASE_URL,
  API_KEY,
  THINKING,
  BASE_SYSTEM,
  getModel,
  newAssistant,
  observedCallsInLastTurn,
  toolNamesCalled,
  MockShortcutsClient,
  writeNote,
  writeSession,
} from "./fixtures";
export type { ObservedCall, AssistantBundle, AssistantOpts, ShortcutsClientLike } from "./fixtures";
export {
  calledTool,
  calledNothing,
  calledToolWithArg,
  toolResultMatches,
  replyMatches,
} from "./judges";
