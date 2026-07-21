import {
	REVIEW_CATEGORIES,
	type ReviewConfidence,
	type ReviewFinding,
	type ReviewSeverity,
} from "../domain/types.js";

const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};
const CONFIDENCE_ORDER: Record<ReviewConfidence, number> = {
	high: 0,
	medium: 1,
	low: 2,
};
const CATEGORY_ORDER = new Map(
	REVIEW_CATEGORIES.map((category, index) => [category, index]),
);

export function requiresAutomaticRepair(finding: ReviewFinding): boolean {
	return (
		finding.severity === "critical" ||
		finding.severity === "high" ||
		(finding.severity === "medium" && finding.confidence === "high")
	);
}

export function prioritizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
	const prioritized = findings
		.map((finding) => ({
			...finding,
			status: requiresAutomaticRepair(finding)
				? ("repair_required" as const)
				: ("deferred" as const),
		}))
		.sort(
			(left, right) =>
				SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
				CONFIDENCE_ORDER[left.confidence] -
					CONFIDENCE_ORDER[right.confidence] ||
				(CATEGORY_ORDER.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
					(CATEGORY_ORDER.get(right.category) ?? Number.MAX_SAFE_INTEGER) ||
				left.id.localeCompare(right.id),
		);
	if (
		prioritized.filter((finding) => finding.status === "repair_required")
			.length > 100
	) {
		throw new Error(
			"More than 100 findings require repair; refusing unsafe automatic repair",
		);
	}
	return prioritized;
}
