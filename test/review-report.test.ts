import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "../src/domain/types.js";
import {
	prioritizeFindings,
	requiresAutomaticRepair,
} from "../src/review/review-policy.js";
import {
	materializeReviewFindings,
	parseReviewReport,
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../src/review/review-report.js";

function output(overrides: Record<string, unknown> = {}): string {
	return `${REVIEW_REPORT_START}\n${JSON.stringify({
		version: 1,
		category: "security",
		baseCommit: "abc123",
		summary: "Found one issue",
		findings: [
			{
				severity: "high",
				confidence: "high",
				title: "Unsafe input",
				description: "Input reaches a process boundary without validation.",
				paths: ["src/process.ts"],
				recommendation: "Validate the input before use.",
			},
		],
		...overrides,
	})}\n${REVIEW_REPORT_END}`;
}

function finding(
	id: string,
	severity: ReviewFinding["severity"],
	confidence: ReviewFinding["confidence"],
): ReviewFinding {
	return {
		id,
		category: "correctness",
		severity,
		confidence,
		title: id,
		description: id,
		paths: ["src/file.ts"],
		recommendation: id,
		status: "deferred",
	};
}

describe("review report protocol", () => {
	it("parses and materializes a valid bounded report", () => {
		const report = parseReviewReport(output(), "security", "abc123");
		expect(report.summary).toBe("Found one issue");
		expect(materializeReviewFindings(report, "security", 2)).toEqual([
			expect.objectContaining({
				id: "review-2-security-001",
				severity: "high",
				status: "deferred",
			}),
		]);
	});

	it.each([
		["missing markers", "{}"],
		["wrong category", output({ category: "tests" })],
		["wrong base", output({ baseCommit: "other" })],
		[
			"unsafe path",
			output({
				findings: [
					{
						severity: "high",
						confidence: "high",
						title: "Unsafe",
						description: "Unsafe",
						paths: ["../secret"],
						recommendation: "Fix",
					},
				],
			}),
		],
	])("rejects %s", (_name, reportOutput) => {
		expect(() =>
			parseReviewReport(reportOutput, "security", "abc123"),
		).toThrow();
	});

	it("prioritizes important findings deterministically", () => {
		const findings = [
			finding("medium-low", "medium", "low"),
			finding("critical-low", "critical", "low"),
			finding("medium-high", "medium", "high"),
			finding("high-low", "high", "low"),
		];
		const prioritized = prioritizeFindings(findings);
		expect(prioritized.map((item) => [item.id, item.status])).toEqual([
			["critical-low", "repair_required"],
			["high-low", "repair_required"],
			["medium-high", "repair_required"],
			["medium-low", "deferred"],
		]);
		expect(requiresAutomaticRepair(findings[0] as ReviewFinding)).toBe(false);
	});

	it("fails rather than truncating an unsafe number of repair findings", () => {
		const findings = Array.from({ length: 101 }, (_, index) =>
			finding(`critical-${index}`, "critical", "high"),
		);
		expect(() => prioritizeFindings(findings)).toThrow(/More than 100/);
	});
});
