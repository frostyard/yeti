export interface RepoLearning {
  path: string;
  summary: string;
}

export interface ParsedLearnings {
  declared: boolean;
  repo: RepoLearning[];
  yeti: string[];
}

/** Extract the machine-readable Learnings declaration from an agent's output. */
export function parseLearnings(output: string): ParsedLearnings {
  const repo: RepoLearning[] = [];
  const yeti: string[] = [];
  let declared = false;

  for (const m of output.matchAll(/^\s*LEARNINGS-REPO:\s*(.*)$/gim)) {
    declared = true;
    const value = m[1].trim();
    if (!value || value.toLowerCase() === "none") continue;
    const fileMatch = value.match(/^(\S+\.md)\s*:\s*(.+)$/);
    if (fileMatch) repo.push({ path: fileMatch[1], summary: fileMatch[2].trim() });
  }

  for (const m of output.matchAll(/^\s*LEARNINGS-YETI:\s*(.*)$/gim)) {
    declared = true;
    const value = m[1].trim();
    if (!value || value.toLowerCase() === "none") continue;
    yeti.push(value);
  }

  return { declared, repo, yeti };
}

/** Remove declaration lines from output destined for GitHub comments/PR bodies. */
export function stripLearningsDeclaration(output: string): string {
  return output
    .replace(/^\s*LEARNINGS-(REPO|YETI):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
