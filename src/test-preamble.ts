import { readPreamble } from "./policy.js";

/**
 * Strip the shared policy preamble from a rendered prompt so job-prompt tests can
 * assert the job-specific body. The preamble mechanism itself is covered in policy.test.ts.
 *
 * Kept separate from test-helpers.ts because it imports policy.js (which imports
 * config.js `WORK_DIR`); only AI-job tests that already mock config fully use it.
 */
export function stripPreamble(prompt: string): string {
  const preamble = readPreamble();
  if (preamble && prompt.startsWith(preamble)) {
    return prompt.slice(preamble.length).replace(/^\n+/, "");
  }
  return prompt;
}
