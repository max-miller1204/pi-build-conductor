import type {
	BuildRun,
	RepairAttempt,
	ReviewCategory,
	ReviewFinding,
} from "../domain/types.js";
import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
	REVIEW_REPORT_VERSION,
} from "./review-report.js";

const CATEGORY_GUIDANCE: Record<ReviewCategory, string> = {
	correctness:
		"Look for incorrect behavior, missing edge cases, invalid assumptions, races, and error-handling defects.",
	security:
		"Look for trust-boundary violations, injection, unsafe file or process handling, credential exposure, and permission problems.",
	maintainability:
		"Look for brittle design, duplicated logic, unclear ownership, excessive coupling, and changes that will be unsafe to evolve.",
	tests:
		"Look for important behavior that is untested, weak assertions, false-positive tests, and missing failure or concurrency coverage.",
	documentation:
		"Look for inaccurate or missing user, operator, API, recovery, and safety documentation caused by the integrated changes.",
};

export function buildReviewerPrompt(
	run: BuildRun,
	category: ReviewCategory,
	baseCommit: string,
): string {
	return `You are the independent ${category} reviewer for build run ${run.id}.
You are fresh and did not implement any task in this run.
Review the complete integrated result at commit ${baseCommit}, compared with base commit ${run.baseCommit}.
${CATEGORY_GUIDANCE[category]}

Original handoff:
${run.handoff.text}

Approved plan:
${JSON.stringify(run.plan, null, 2)}

Do not modify files, create commits, switch branches, or create worktrees.
Inspect the repository and run read-only checks when useful.
Report only concrete, actionable, repository-specific findings supported by evidence.
Use severity critical, high, medium, or low and confidence high, medium, or low.
Every finding must name at least one safe repository-relative path.
Return exactly one JSON object between the markers below and no other text.

${REVIEW_REPORT_START}
{
  "version": ${REVIEW_REPORT_VERSION},
  "category": ${JSON.stringify(category)},
  "baseCommit": ${JSON.stringify(baseCommit)},
  "summary": "concise review summary",
  "findings": [
    {
      "severity": "high",
      "confidence": "high",
      "title": "short title",
      "description": "specific impact and evidence",
      "paths": ["src/example.ts"],
      "recommendation": "specific repair"
    }
  ]
}
${REVIEW_REPORT_END}`;
}

export function buildRepairPrompt(
	run: BuildRun,
	attempt: RepairAttempt,
	findings: ReviewFinding[],
): string {
	return `You are an isolated repair worker for build run ${run.id}.
Address the prioritized independent-review findings below on top of integration commit ${attempt.baseCommit}.

${JSON.stringify(findings, null, 2)}

Original handoff:
${run.handoff.text}

Approved path scope:
${[...new Set(run.plan.tasks.flatMap((task) => task.allowedPaths))]
	.sort((left, right) => left.localeCompare(right))
	.map((path) => `- ${path}`)
	.join("\n")}

Work only in the current worktree and current branch.
Do not create, switch, merge, or delete branches or worktrees.
Do not commit changes; the conductor will validate, commit, and integrate them.
Do not make unrelated improvements or expand beyond the listed findings.
Run focused checks and summarize the files and findings addressed when finished.`;
}
