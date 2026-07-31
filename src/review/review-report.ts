import type {
	ReviewCategory,
	ReviewConfidence,
	ReviewFinding,
	ReviewSeverity,
} from "../domain/types.js";

export const REVIEW_REPORT_VERSION = 1 as const;
export const REVIEW_REPORT_START = "BEGIN_PI_BUILD_REVIEW_REPORT";
export const REVIEW_REPORT_END = "END_PI_BUILD_REVIEW_REPORT";
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_FINDINGS = 50;
const SEVERITIES: ReadonlySet<ReviewSeverity> = new Set([
	"critical",
	"high",
	"medium",
	"low",
]);
const CONFIDENCES: ReadonlySet<ReviewConfidence> = new Set([
	"high",
	"medium",
	"low",
]);

interface ReviewReportFinding {
	severity: ReviewSeverity;
	confidence: ReviewConfidence;
	title: string;
	description: string;
	paths: string[];
	recommendation: string;
}

export interface ParsedReviewReport {
	summary: string;
	findings: ReviewReportFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	if (value.length > maximum) {
		throw new Error(`${path} exceeds ${maximum} characters`);
	}
	return value.trim();
}

function safePath(value: unknown, path: string): string {
	const candidate = requiredString(value, path, 1_024).replaceAll("\\", "/");
	if (
		candidate.startsWith("/") ||
		/^[a-zA-Z]:\//.test(candidate) ||
		candidate.includes("//") ||
		candidate === "." ||
		candidate === ".." ||
		candidate.startsWith("../") ||
		candidate.includes("/../") ||
		candidate.endsWith("/..") ||
		candidate.includes("/./") ||
		candidate.endsWith("/.") ||
		candidate === ".git" ||
		candidate.startsWith(".git/") ||
		candidate.includes("\0")
	) {
		throw new Error(`${path} must be a safe repository-relative path`);
	}
	return candidate;
}

function extractPayload(output: string): string {
	if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) {
		throw new Error(`Review report exceeds ${MAX_REPORT_BYTES} bytes`);
	}
	const start = output.indexOf(REVIEW_REPORT_START);
	const end = output.indexOf(REVIEW_REPORT_END);
	if (
		start < 0 ||
		end < 0 ||
		end <= start ||
		output.slice(start + 1).includes(REVIEW_REPORT_START) ||
		output.slice(end + 1).includes(REVIEW_REPORT_END)
	) {
		throw new Error(
			"Review output must contain exactly one report marker pair",
		);
	}
	if (
		output.slice(0, start).trim() ||
		output.slice(end + REVIEW_REPORT_END.length).trim()
	) {
		throw new Error(
			"Review output must contain only the marked report payload",
		);
	}
	return output.slice(start + REVIEW_REPORT_START.length, end).trim();
}

export function parseReviewReport(
	output: string | undefined,
	expectedCategory: ReviewCategory,
	expectedBaseCommit: string,
): ParsedReviewReport {
	if (output === undefined) {
		throw new Error("Reviewer returned no final output");
	}
	let value: unknown;
	try {
		value = JSON.parse(extractPayload(output));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Reviewer returned invalid JSON: ${error.message}`);
		}
		throw error;
	}
	if (!isRecord(value)) {
		throw new Error("Review report must be an object");
	}
	if (value.version !== REVIEW_REPORT_VERSION) {
		throw new Error(
			`Unsupported review report version: ${String(value.version)}`,
		);
	}
	if (value.category !== expectedCategory) {
		throw new Error(
			`Review category mismatch: expected ${expectedCategory}, received ${String(value.category)}`,
		);
	}
	if (value.baseCommit !== expectedBaseCommit) {
		throw new Error(
			`Review base mismatch: expected ${expectedBaseCommit}, received ${String(value.baseCommit)}`,
		);
	}
	const summary = requiredString(value.summary, "report.summary", 8_192);
	if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
		throw new Error(
			`report.findings must contain at most ${MAX_FINDINGS} items`,
		);
	}
	const fingerprints = new Set<string>();
	const findings = value.findings.map(
		(candidate, index): ReviewReportFinding => {
			const path = `report.findings[${index}]`;
			if (!isRecord(candidate)) {
				throw new Error(`${path} must be an object`);
			}
			if (
				typeof candidate.severity !== "string" ||
				!SEVERITIES.has(candidate.severity as ReviewSeverity)
			) {
				throw new Error(`${path}.severity is invalid`);
			}
			if (
				typeof candidate.confidence !== "string" ||
				!CONFIDENCES.has(candidate.confidence as ReviewConfidence)
			) {
				throw new Error(`${path}.confidence is invalid`);
			}
			if (!Array.isArray(candidate.paths) || candidate.paths.length === 0) {
				throw new Error(`${path}.paths must be a non-empty array`);
			}
			const paths = [
				...new Set(
					candidate.paths.map((item, pathIndex) =>
						safePath(item, `${path}.paths[${pathIndex}]`),
					),
				),
			].sort((left, right) => left.localeCompare(right));
			const finding = {
				severity: candidate.severity as ReviewSeverity,
				confidence: candidate.confidence as ReviewConfidence,
				title: requiredString(candidate.title, `${path}.title`, 512),
				description: requiredString(
					candidate.description,
					`${path}.description`,
					8_192,
				),
				paths,
				recommendation: requiredString(
					candidate.recommendation,
					`${path}.recommendation`,
					4_096,
				),
			};
			const fingerprint = `${finding.title.toLowerCase()}\0${paths.join("\0")}`;
			if (fingerprints.has(fingerprint)) {
				throw new Error(`${path} duplicates another finding`);
			}
			fingerprints.add(fingerprint);
			return finding;
		},
	);
	return { summary, findings };
}

export function materializeReviewFindings(
	report: ParsedReviewReport,
	category: ReviewCategory,
	round: number,
): ReviewFinding[] {
	return report.findings.map((finding, index) => ({
		id: reviewFindingId(round, category, index),
		category,
		...finding,
		status: "deferred",
	}));
}

export function reviewFindingId(
	round: number,
	category: ReviewCategory,
	index: number,
): string {
	return `review-${round}-${category}-${String(index + 1).padStart(3, "0")}`;
}
