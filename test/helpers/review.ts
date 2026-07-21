import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../../src/review/review-report.js";
import type { WorkerExecutionResult } from "../../src/workers/backend.js";

export function reviewResult(
	prompt: string,
): WorkerExecutionResult | undefined {
	const category = prompt.match(
		/independent (correctness|security|maintainability|tests|documentation) reviewer/,
	)?.[1];
	const baseCommit = prompt.match(
		/Review the complete integrated result at commit ([^,]+),/,
	)?.[1];
	if (!category || !baseCommit) {
		return undefined;
	}
	return {
		status: "succeeded",
		output: `${REVIEW_REPORT_START}\n${JSON.stringify({
			version: 1,
			category,
			baseCommit,
			summary: "No findings in test review",
			findings: [],
		})}\n${REVIEW_REPORT_END}`,
	};
}
