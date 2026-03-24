import fs from "node:fs";
import path from "node:path";
import { JOB_AI, SELF_REPO, WORK_DIR, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";

// ── Prompt registry ──

export interface PromptEntry {
  name: string;
  file: string;
  functionName: string;
  purpose: string;
}

export const PROMPT_REGISTRY: PromptEntry[] = [
  {
    name: "buildNewPlanPrompt",
    file: "src/jobs/issue-refiner.ts",
    functionName: "buildNewPlanPrompt",
    purpose: "Produce an initial implementation plan from a GitHub issue",
  },
  {
    name: "buildRefinementPrompt",
    file: "src/jobs/issue-refiner.ts",
    functionName: "buildRefinementPrompt",
    purpose: "Refine an existing plan based on human feedback comments",
  },
  {
    name: "buildFollowUpPrompt",
    file: "src/jobs/issue-refiner.ts",
    functionName: "buildFollowUpPrompt",
    purpose: "Answer follow-up questions on an issue while a PR is open",
  },
  {
    name: "buildReviewPrompt",
    file: "src/jobs/plan-reviewer.ts",
    functionName: "buildReviewPrompt",
    purpose: "Critically review an implementation plan for flaws, missing edge cases, and risks",
  },
  {
    name: "buildPrompt (issue-worker)",
    file: "src/jobs/issue-worker.ts",
    functionName: "buildPrompt",
    purpose: "Implement a solution for an issue based on its plan, with phase-aware multi-PR support",
  },
];

// ── State persistence ──

export interface EvalState {
  lastIndex: number;
  lastRunDate: string;
}

const STATE_PATH = path.join(WORK_DIR, "prompt-eval-state.json");

export function loadState(): EvalState {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastIndex: 0, lastRunDate: "" };
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<EvalState>;
    return {
      lastIndex: typeof parsed.lastIndex === "number" ? parsed.lastIndex : 0,
      lastRunDate: typeof parsed.lastRunDate === "string" ? parsed.lastRunDate : "",
    };
  } catch {
    return { lastIndex: 0, lastRunDate: "" };
  }
}

export function saveState(state: EvalState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ── JSON parsing helpers ──

function extractJson(output: string): string | null {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceMatch = output.match(/\{[\s\S]*\}/);
  return braceMatch ? braceMatch[0] : null;
}

interface TestCase {
  title: string;
  body: string;
}

function parseTestInputs(output: string): TestCase[] {
  const raw = extractJson(output);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { testCases?: unknown[] };
    if (!Array.isArray(parsed.testCases)) return [];
    return parsed.testCases.filter(
      (item): item is TestCase =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as TestCase).title === "string" &&
        typeof (item as TestCase).body === "string",
    );
  } catch {
    return [];
  }
}

interface VariantResult {
  variant: string;
  rationale: string;
}

function parseVariant(output: string): VariantResult | null {
  const raw = extractJson(output);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VariantResult>;
    if (typeof parsed.variant !== "string" || typeof parsed.rationale !== "string") return null;
    return { variant: parsed.variant, rationale: parsed.rationale };
  } catch {
    return null;
  }
}

interface Scores {
  specificity: number;
  actionability: number;
  scopeAwareness: number;
  uncertainty: number;
}

interface Judgment {
  scores: { current: Scores; variant: Scores };
  winner: "current" | "variant" | "tie";
  reasoning: string;
}

function isScoreValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 5
  );
}

function isScores(obj: unknown): obj is Scores {
  if (!obj || typeof obj !== "object") return false;
  const maybe = obj as Partial<Scores>;
  return (
    isScoreValue(maybe.specificity) &&
    isScoreValue(maybe.actionability) &&
    isScoreValue(maybe.scopeAwareness) &&
    isScoreValue(maybe.uncertainty)
  );
}

export function parseJudgment(output: string): Judgment | null {
  const raw = extractJson(output);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.winner !== "current" &&
      parsed.winner !== "variant" &&
      parsed.winner !== "tie"
    ) {
      return null;
    }
    if (typeof parsed.reasoning !== "string") return null;
    const scores = parsed.scores as { current?: unknown; variant?: unknown } | undefined;
    if (!scores || typeof scores !== "object") return null;
    if (!isScores(scores.current) || !isScores(scores.variant)) return null;
    return parsed as unknown as Judgment;
  } catch {
    return null;
  }
}

// ── Report builder ──

interface EvalResult {
  testCase: TestCase;
  currentOutput: string;
  variantOutput: string;
  judgment: Judgment;
}

export function buildReport(
  promptName: string,
  rationale: string,
  results: EvalResult[],
): { title: string; body: string } {
  const title = `[prompt-evaluator] Improvement found: ${promptName}`;

  const variantWins = results.filter((r) => r.judgment.winner === "variant").length;

  const sections = results.map((r, i) => {
    const j = r.judgment;
    const currentTotal = j.scores.current.specificity + j.scores.current.actionability + j.scores.current.scopeAwareness + j.scores.current.uncertainty;
    const variantTotal = j.scores.variant.specificity + j.scores.variant.actionability + j.scores.variant.scopeAwareness + j.scores.variant.uncertainty;
    return [
      `### Test Case ${i + 1}: ${r.testCase.title}`,
      ``,
      `**Issue body:** ${r.testCase.body}`,
      ``,
      `**Winner:** ${j.winner} | Current: ${currentTotal}/20 | Variant: ${variantTotal}/20`,
      ``,
      `**Reasoning:** ${j.reasoning}`,
      ``,
      `<details><summary>Current prompt output</summary>`,
      ``,
      r.currentOutput,
      ``,
      `</details>`,
      ``,
      `<details><summary>Variant prompt output</summary>`,
      ``,
      r.variantOutput,
      ``,
      `</details>`,
    ].join("\n");
  });

  const body = [
    `## Prompt Evaluation: \`${promptName}\``,
    ``,
    `**Result:** Variant wins ${variantWins}/${results.length} test cases`,
    ``,
    `### Proposed Change Rationale`,
    ``,
    rationale,
    ``,
    `---`,
    ``,
    ...sections,
    ``,
    `---`,
    `*Automated evaluation by yeti prompt-evaluator*`,
  ].join("\n");

  return { title, body };
}

// ── Prompt builders for the evaluation pipeline ──

function buildTestInputPrompt(promptSource: string, purpose: string): string {
  return [
    `You are helping evaluate an AI prompt used in a GitHub automation system.`,
    ``,
    `The prompt's purpose: ${purpose}`,
    ``,
    `Here is the current prompt function source code:`,
    ``,
    "```typescript",
    promptSource,
    "```",
    ``,
    `Generate 4 diverse test cases (GitHub issues) to evaluate this prompt against.`,
    `Include:`,
    `- 2 realistic issues (one well-specified, one vague/underspecified)`,
    `- 2 adversarial edge cases (e.g., overly broad scope, missing acceptance criteria, ambiguous requirements)`,
    ``,
    `Return JSON in this exact format:`,
    "```json",
    `{`,
    `  "testCases": [`,
    `    { "title": "Issue title", "body": "Issue body text" }`,
    `  ]`,
    `}`,
    "```",
    ``,
    `Return ONLY the JSON, no other text.`,
  ].join("\n");
}

function buildVariantPrompt(promptSource: string, purpose: string): string {
  return [
    `You are a prompt engineer improving an AI prompt used in a GitHub automation system.`,
    ``,
    `The prompt's purpose: ${purpose}`,
    ``,
    `Here is the current prompt function source code:`,
    ``,
    "```typescript",
    promptSource,
    "```",
    ``,
    `Analyze this prompt for weaknesses and propose an improved version.`,
    `Consider:`,
    `- Does it handle underspecified inputs well?`,
    `- Does it give clear, actionable instructions?`,
    `- Does it avoid encouraging guessing or speculation?`,
    `- Is the scope guidance clear?`,
    `- Are there missing instructions that would improve output quality?`,
    ``,
    `Return JSON in this exact format:`,
    "```json",
    `{`,
    `  "variant": "The complete improved prompt text (not the function, just the prompt string it would produce)",`,
    `  "rationale": "Explanation of what was changed and why"`,
    `}`,
    "```",
    ``,
    `Return ONLY the JSON, no other text.`,
  ].join("\n");
}

function buildJudgePrompt(testCase: TestCase, currentOutput: string, variantOutput: string): string {
  return [
    `You are judging two AI outputs produced by different prompts for the same input.`,
    ``,
    `## Test Input (GitHub Issue)`,
    `**Title:** ${testCase.title}`,
    `**Body:** ${testCase.body}`,
    ``,
    `## Output A (Current Prompt)`,
    currentOutput,
    ``,
    `## Output B (Variant Prompt)`,
    variantOutput,
    ``,
    `Score each output on these criteria (1-5 scale):`,
    `- **specificity**: Does it reference concrete files, functions, or patterns?`,
    `- **actionability**: Could a developer implement from this output?`,
    `- **scopeAwareness**: Does it avoid over-engineering or under-engineering?`,
    `- **uncertainty**: Does it flag ambiguity instead of guessing? (5 = appropriately uncertain)`,
    ``,
    `Return JSON in this exact format:`,
    "```json",
    `{`,
    `  "scores": {`,
    `    "current": { "specificity": 3, "actionability": 3, "scopeAwareness": 3, "uncertainty": 3 },`,
    `    "variant": { "specificity": 4, "actionability": 4, "scopeAwareness": 4, "uncertainty": 4 }`,
    `  },`,
    `  "winner": "variant",`,
    `  "reasoning": "Brief explanation of why the winner is better"`,
    `}`,
    "```",
    ``,
    `Return ONLY the JSON, no other text.`,
  ].join("\n");
}

// ── Main job ──

const REQUIRED_TEST_CASES = 4;
const WIN_THRESHOLD = 3; // variant must win at least 3 of 4 test cases

async function evaluatePrompt(entry: PromptEntry, repo: Repo): Promise<void> {
  const fullName = repo.fullName;
  const taskId = db.recordTaskStart("prompt-evaluator", SELF_REPO, 0, null);
  let wtPath: string | undefined;

  try {
    // Use detached worktree — this job only reads files, never pushes
    wtPath = await claude.createWorktreeFromBranch(repo, repo.defaultBranch, "prompt-evaluator");
    db.updateTaskWorktree(taskId, wtPath, repo.defaultBranch);

    // Read prompt source from the worktree
    const sourceFile = path.join(wtPath, entry.file);
    const promptSource = fs.readFileSync(sourceFile, "utf-8");

    const aiOptions = JOB_AI["prompt-evaluator"];
    const enqueue = claude.resolveEnqueue(aiOptions);

    // Step 2: Generate test inputs
    log.info(`[prompt-evaluator] Generating test inputs for ${entry.name}`);
    const testInputPrompt = buildTestInputPrompt(promptSource, entry.purpose);
    const testInputOutput = await enqueue(() => claude.runAI(testInputPrompt, wtPath!, aiOptions));
    const testCases = parseTestInputs(testInputOutput).slice(0, REQUIRED_TEST_CASES);
    if (testCases.length < REQUIRED_TEST_CASES) {
      log.warn(`[prompt-evaluator] Need ${REQUIRED_TEST_CASES} test inputs for ${entry.name}, got ${testCases.length}`);
      db.recordTaskComplete(taskId);
      return;
    }

    // Step 3: Generate variant
    log.info(`[prompt-evaluator] Generating variant for ${entry.name}`);
    const variantPrompt = buildVariantPrompt(promptSource, entry.purpose);
    const variantOutput = await enqueue(() => claude.runAI(variantPrompt, wtPath!, aiOptions));
    const variant = parseVariant(variantOutput);
    if (!variant) {
      log.warn(`[prompt-evaluator] Failed to generate variant for ${entry.name}`);
      db.recordTaskComplete(taskId);
      return;
    }

    // Step 4: Run A/B comparisons
    log.info(`[prompt-evaluator] Running A/B comparison for ${entry.name} (${testCases.length} test cases)`);
    const comparisons: { testCase: TestCase; currentOutput: string; variantOutput: string }[] = [];

    for (const testCase of testCases) {
      // Run current prompt — reconstruct from source with test data
      const currentPromptText = buildSimulatedPrompt(promptSource, entry, testCase);
      const currentOutput = await enqueue(() => claude.runAI(currentPromptText, wtPath!, aiOptions));

      // Run variant prompt with test data (use the same simulation scaffolding)
      const variantPromptText = buildSimulatedPrompt(variant.variant, entry, testCase);
      const variantOut = await enqueue(() => claude.runAI(variantPromptText, wtPath!, aiOptions));

      comparisons.push({ testCase, currentOutput, variantOutput: variantOut });
    }

    // Step 5: Judge
    log.info(`[prompt-evaluator] Judging outputs for ${entry.name}`);
    const results: EvalResult[] = [];

    for (const comp of comparisons) {
      const judgePrompt = buildJudgePrompt(comp.testCase, comp.currentOutput, comp.variantOutput);
      const judgeOutput = await enqueue(() => claude.runAI(judgePrompt, wtPath!, aiOptions));
      const judgment = parseJudgment(judgeOutput);
      if (judgment) {
        results.push({ ...comp, judgment });
      }
    }

    // Step 6: Report
    if (results.length < REQUIRED_TEST_CASES) {
      log.warn(`[prompt-evaluator] Only ${results.length}/${REQUIRED_TEST_CASES} judgments parsed for ${entry.name} — skipping`);
      db.recordTaskComplete(taskId);
      return;
    }

    const variantWins = results.filter((r) => r.judgment.winner === "variant").length;
    log.info(`[prompt-evaluator] ${entry.name}: variant wins ${variantWins}/${results.length} test cases`);

    if (variantWins >= WIN_THRESHOLD) {
      // Build expected issue title and check for existing evaluation issue
      const title = `[prompt-evaluator] Improvement found: ${entry.name}`;
      const existing = (await gh.searchIssues(SELF_REPO, title)).filter((r) => r.title === title);
      if (existing.length > 0) {
        log.info(`[prompt-evaluator] Skipping — similar issue already exists: #${existing[0].number}`);
      } else {
        const report = buildReport(entry.name, variant.rationale, results);
        const issueNumber = await gh.createIssue(SELF_REPO, report.title, report.body, ["prompt-improvement"]);
        log.info(`[prompt-evaluator] Created issue #${issueNumber} for ${entry.name}`);
        notify(`[prompt-evaluator] Improvement found for ${entry.name} — issue #${issueNumber}\n${gh.issueUrl(SELF_REPO, issueNumber)}`);
      }
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

/**
 * Build a simplified version of the current prompt with test data substituted.
 * Since prompt functions are module-private, we reconstruct a representative
 * prompt by prepending the test case to the prompt source's core instructions.
 */
function buildSimulatedPrompt(promptSource: string, entry: PromptEntry, testCase: TestCase): string {
  return [
    `You are analyzing a GitHub issue for a repository.`,
    `Issue: ${testCase.title}`,
    ``,
    testCase.body,
    ``,
    `The following prompt instructions are what you should follow:`,
    ``,
    `(This prompt was extracted from the function ${entry.functionName} — follow its intent)`,
    ``,
    promptSource,
  ].join("\n");
}

// ── Entry point ──

export async function run(repos: Repo[]): Promise<void> {
  // Use SELF_REPO as the source codebase for prompt sources
  const repo = repos.find((r) => r.fullName === SELF_REPO);
  if (!repo) {
    log.warn(`[prompt-evaluator] SELF_REPO '${SELF_REPO}' not found in provided repos (count=${repos.length})`);
    return;
  }

  const state = loadState();
  const currentIndex = state.lastIndex % PROMPT_REGISTRY.length;
  const entry = PROMPT_REGISTRY[currentIndex];

  log.info(`[prompt-evaluator] Evaluating prompt: ${entry.name} (index ${currentIndex})`);

  try {
    await evaluatePrompt(entry, repo);
  } catch (err) {
    reportError("prompt-evaluator:evaluate", `${entry.name}`, err);
  }

  // Advance state regardless of success/failure
  const nextIndex = (currentIndex + 1) % PROMPT_REGISTRY.length;
  saveState({ lastIndex: nextIndex, lastRunDate: new Date().toISOString().slice(0, 10) });
}
