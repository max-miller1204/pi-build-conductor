import type {
	FinalValidationAttempt,
	FinalValidationEvidence,
	TaskValidationEvidence,
	ValidationCheckEvidence,
	WorkerRole,
} from "../domain/types.js";
import { formatCommand } from "../planning/plan-presentation.js";
import { securityPolicyLines, workerLaunchPolicy } from "../security/policy.js";
import { recommendedRunAction } from "./run-control.js";
import {
	type RunAttemptView,
	type RunUnitRole,
	type RunUnitView,
	type RunView,
	reviewRoundViews,
	workUnits,
} from "./run-view.js";

const MAX_INLINE_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 2_000;
const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_LINE_LENGTH = 300;

export type RunAttemptResolution =
	| { kind: "step"; attempt: RunAttemptView }
	| { kind: "final-validation"; attempt: FinalValidationAttempt };

function isUnsafeTerminalCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0x2028 && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function safeInline(value: string, maximum = MAX_INLINE_LENGTH): string {
	const safe = [...value]
		.map((character) =>
			isUnsafeTerminalCharacter(character) ? " " : character,
		)
		.join("")
		.trim();
	return safe.length <= maximum
		? safe
		: `${safe.slice(0, Math.max(0, maximum - 1))}…`;
}

function display(value: string | undefined, fallback = "none"): string {
	return value === undefined || value.length === 0
		? fallback
		: safeInline(value);
}

function displayList(values: readonly string[], fallback = "none"): string {
	return values.length > 0
		? safeInline(values.map((value) => safeInline(value, 200)).join(", "))
		: fallback;
}

function commandText(check: Pick<ValidationCheckEvidence, "command" | "args">) {
	return safeInline(formatCommand(check), MAX_INLINE_LENGTH);
}

function outputTailLines(label: string, output: string): string[] {
	if (output.length === 0) {
		return [`  ${label}: (empty)`];
	}
	const bounded =
		output.length > MAX_OUTPUT_LENGTH
			? `…${output.slice(output.length - MAX_OUTPUT_LENGTH + 1)}`
			: output;
	const rawLines = bounded.split(/\r\n|\r|\n/);
	const selected = rawLines.slice(-MAX_OUTPUT_LINES);
	const omitted = rawLines.length - selected.length;
	return [
		`  ${label} tail${output.length > bounded.length || omitted > 0 ? " (truncated)" : ""}:`,
		...(omitted > 0 ? [`    … ${omitted} earlier line(s) omitted`] : []),
		...selected.map(
			(line) => `    ${safeInline(line, MAX_OUTPUT_LINE_LENGTH) || " "}`,
		),
	];
}

function renderCheck(check: ValidationCheckEvidence, index: number): string[] {
	const boundary = check.executionBoundary;
	return [
		`Check ${index + 1}: ${check.passed ? "passed" : "failed"} (exit ${check.exitCode ?? "none"}) - ${commandText(check)}`,
		`  Started: ${display(check.startedAt)} | Finished: ${display(check.finishedAt)}`,
		`  Boundary: ${boundary ? `${boundary.sandbox} sandbox, ${boundary.network} network, ${boundary.environment}` : "legacy unrecorded"}`,
		...outputTailLines("stdout", check.stdoutTail),
		...outputTailLines("stderr", check.stderrTail),
	];
}

function changedFileText(evidence: TaskValidationEvidence): string {
	if (evidence.changedFiles.length === 0) {
		return "none";
	}
	return safeInline(
		evidence.changedFiles
			.map((file) => {
				const rename = file.previousPath ? `${file.previousPath} -> ` : "";
				return `${file.status} ${rename}${file.path}`;
			})
			.join(", "),
	);
}

function renderEvidence(
	evidence: TaskValidationEvidence | FinalValidationEvidence | undefined,
): string[] {
	if (!evidence) {
		return ["Evidence: none recorded"];
	}
	const passed = evidence.checks.filter((check) => check.passed).length;
	const unitLines: string[] = [];
	if ("changedFiles" in evidence) {
		unitLines.push(
			`Diff hash: ${display(evidence.diffHash)}`,
			`Changed files: ${changedFileText(evidence)}`,
		);
	}
	return [
		`Evidence: ${evidence.passed ? "passed" : "failed"}, checks ${passed}/${evidence.checks.length}`,
		`Evidence time: ${display(evidence.startedAt)} -> ${display(evidence.finishedAt)}`,
		...unitLines,
		...evidence.checks.flatMap(renderCheck),
	];
}

/** How the run's own work is progressing, ignoring its reviews of that work. */
export function unitStateSummary(view: RunView): string {
	const counts = workUnits(view).reduce((result, unit) => {
		result.set(unit.state, (result.get(unit.state) ?? 0) + 1);
		return result;
	}, new Map<string, number>());
	const summary = [
		"running",
		"validating",
		"succeeded",
		"ready",
		"planned",
		"blocked",
		"failed",
		"cancelled",
	]
		.flatMap((state) => {
			const count = counts.get(state);
			return count ? [`${count} ${state}`] : [];
		})
		.join(", ");
	return summary || "none";
}

export function reviewStateSummary(view: RunView): string {
	const round = latestStartedReviewRound(view);
	if (!round) {
		return "Reviews: not started";
	}
	return `Review round ${round.number}: ${round.reported}/${round.categories} reports received, ${round.findings.repair_required} repair-required, ${round.findings.unresolved} unresolved, ${round.findings.deferred} deferred`;
}

function latestStartedReviewRound(view: RunView) {
	const started = new Set(
		view.units.flatMap((unit) =>
			unit.review && unit.attemptIds.length > 0 ? [unit.review.round] : [],
		),
	);
	return reviewRoundViews(view)
		.filter((round) => started.has(round.number))
		.at(-1);
}

function latestReviewRoundLines(view: RunView): string[] {
	const round = latestStartedReviewRound(view);
	if (!round) {
		return [];
	}
	const finished = round.finishedAt
		? display(round.finishedAt)
		: round.state === "running" || round.state === "repairing"
			? "in progress"
			: "finished (time unavailable)";
	let line = `Latest review round: ${round.state}; base ${display(round.baseCommit)}; ${display(round.startedAt)} -> ${finished}`;
	if (round.repairAttemptId) {
		line += `; repair ${display(round.repairAttemptId)}`;
	}
	if (round.error) {
		line += `; error: ${safeInline(round.error)}`;
	}
	return [line];
}

function isFollowableAttempt(attempt: RunAttemptView): boolean {
	return (
		attempt.workerId !== undefined &&
		["launched", "running"].includes(attempt.state)
	);
}

function byRecency(left: RunAttemptView, right: RunAttemptView): number {
	return (
		right.startedAt.localeCompare(left.startedAt) || right.number - left.number
	);
}

export function latestWorkerAttempt(view: RunView): RunAttemptView | undefined {
	return view.attempts
		.filter((attempt) => attempt.workerId !== undefined)
		.sort(byRecency)[0];
}

export function latestFollowableWorkerAttempt(
	view: RunView,
): RunAttemptView | undefined {
	return view.attempts.filter(isFollowableAttempt).sort(byRecency)[0];
}

function nextRunAction(view: RunView): string {
	if (view.state === "completed" || view.state === "cancelled") {
		return `/orchestrate-prune ${safeInline(view.id)}`;
	}
	if (view.state === "failed") {
		const recommended = recommendedRunAction(view);
		if (recommended.action === "retry") {
			return `/orchestrate-retry ${safeInline(view.id)}`;
		}
		if (recommended.action === "resume") {
			return `/orchestrate-resume ${safeInline(view.id)}`;
		}
		return `/orchestrate-show ${safeInline(view.id)}`;
	}
	if (
		["running", "integrating", "reviewing", "repairing"].includes(view.state)
	) {
		const followable = latestFollowableWorkerAttempt(view);
		if (followable) {
			return `/orchestrate-follow ${safeInline(view.id)} ${safeInline(followable.id)}`;
		}
		return `/orchestrate-cancel ${safeInline(view.id)}`;
	}
	return `/orchestrate-resume ${safeInline(view.id)}`;
}

export function renderRunList(views: readonly RunView[]): string[] {
	if (views.length === 0) {
		return [
			"No orchestration runs found.",
			"Next: /orchestrate <request-file>",
		];
	}
	const sorted = [...views].sort(
		(left, right) =>
			right.updatedAt.localeCompare(left.updatedAt) ||
			left.id.localeCompare(right.id),
	);
	return [
		`Orchestration runs (${views.length}), newest first:`,
		...sorted.map(
			(view) =>
				`${display(view.updatedAt)} | ${safeInline(view.id)} | ${view.state} | ${unitStateSummary(view)} | ${safeInline(view.title)}`,
		),
		"Next: /orchestrate-show <run-id>",
	];
}

function renderUnitOverview(unit: RunUnitView): string {
	let details = `- ${safeInline(unit.id)} [${unit.state}] ${safeInline(unit.title)}; dependencies: ${displayList(unit.dependencies)}; attempts: ${unit.attemptIds.length}`;
	if (unit.integratedCommit) {
		details += `; integrated ${display(unit.integratedCommit)}`;
	}
	if (unit.integrationError) {
		details += `; error: ${safeInline(unit.integrationError)}`;
	}
	return details;
}

function blockedWorkerLines(view: RunView, attemptId?: string): string[] {
	const blockedWorkers = attemptId
		? view.blockedWorkers.filter((blocked) => blocked.attemptId === attemptId)
		: view.blockedWorkers;
	if (blockedWorkers.length === 0) {
		return [attemptId ? "Worker prompts: none" : "Blocked workers: none"];
	}
	return [
		attemptId
			? `Worker prompts: ${blockedWorkers.length} pending`
			: `Blocked workers: ${blockedWorkers.length}`,
		...blockedWorkers.map(
			(blocked) =>
				`- ${safeInline(blocked.attemptId)} / ${safeInline(blocked.workerId)} waiting on ${blocked.method} since ${display(blocked.blockedAt)}${blocked.timeoutAt ? `; timeout ${display(blocked.timeoutAt)}` : ""}`,
		),
	];
}

function finalValidationLines(view: RunView): string[] {
	const attempt = view.finalValidationAttempts.at(-1);
	if (!attempt) {
		return ["Final validation: not started"];
	}
	let line = `Final validation: ${attempt.state} at ${display(attempt.integrationCommit)}`;
	if (attempt.evidence) {
		const passed = attempt.evidence.checks.filter(
			(check) => check.passed,
		).length;
		line += `; checks ${passed}/${attempt.evidence.checks.length}`;
	}
	if (attempt.error) {
		line += `; error: ${safeInline(attempt.error)}`;
	}
	return [line];
}

function attemptCountLine(view: RunView): string {
	const counts = new Map<RunUnitRole, number>();
	for (const attempt of view.attempts) {
		counts.set(attempt.role, (counts.get(attempt.role) ?? 0) + 1);
	}
	const parts = [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([role, count]) => `${count} ${role}`);
	return `Attempts: ${[...parts, `${view.finalValidationAttempts.length} final validation`].join(", ")}`;
}

export function renderRunOverview(view: RunView): string[] {
	return [
		`Run ${safeInline(view.id)}: ${safeInline(view.title)}`,
		`State: ${view.state} | Execution record: ${view.source} | Snapshot revision: ${view.revision} | Schema: ${view.schemaVersion}`,
		`Created: ${display(view.createdAt)} | Updated: ${display(view.updatedAt)} | Approved: ${display(view.approvedAt, "not approved")}`,
		`Repository: ${display(view.repositoryRoot)}`,
		`Base: ${display(view.baseBranch)} @ ${display(view.baseCommit)}`,
		`Integration: ${display(view.integrationBranch)} @ ${display(view.integrationHead)}`,
		`Plan revision: ${view.planRevision}${view.approvedPlanRevision ? ` (approved ${view.approvedPlanRevision})` : ""} | Worker limit: ${view.maxConcurrentWorkers}`,
		`Request: ${display(view.requestPath)}`,
		"Security boundary:",
		...securityPolicyLines(view.securityPolicy).map((line) => safeInline(line)),
		`Steps: ${unitStateSummary(view)}`,
		...workUnits(view).map(renderUnitOverview),
		reviewStateSummary(view),
		...latestReviewRoundLines(view),
		attemptCountLine(view),
		...blockedWorkerLines(view),
		...finalValidationLines(view),
		`Merge-ready evidence: ${view.mergeReadyEvidence ? `generated ${display(view.mergeReadyEvidence.generatedAt)}` : "none"}`,
		...(view.error ? [`Run error: ${safeInline(view.error)}`] : []),
		`Next: ${nextRunAction(view)}`,
	];
}

function bulletLines(values: readonly string[]): string[] {
	if (values.length === 0) {
		return ["- none"];
	}
	return values.map((value) => `- ${safeInline(value)}`);
}

function attemptHistoryLines(
	view: RunView,
	attemptIds: readonly string[],
): { lines: string[]; latest: RunAttemptView | undefined } {
	if (attemptIds.length === 0) {
		return { lines: ["- none"], latest: undefined };
	}
	let latest: RunAttemptView | undefined;
	const lines = attemptIds.flatMap((attemptId) => {
		const attempt = view.attempts.find(
			(candidate) => candidate.id === attemptId,
		);
		if (!attempt) {
			return [`- ${safeInline(attemptId)}: missing attempt record`];
		}
		latest = attempt;
		const attemptLines = [
			`- #${attempt.number} ${safeInline(attempt.id)}: ${attempt.state}, worker ${display(attempt.workerId, "not assigned")}, ${display(attempt.startedAt)} -> ${display(attempt.finishedAt, "in progress")}`,
			`  branch ${display(attempt.branch)} | workspace ${display(attempt.workspacePath)}`,
			`  base ${display(attempt.baseCommit)} | commit ${display(attempt.commit)}`,
		];
		if (attempt.evidence) {
			const passingChecks = attempt.evidence.checks.filter(
				(check) => check.passed,
			).length;
			attemptLines.push(
				`  evidence ${attempt.evidence.passed ? "passed" : "failed"}; checks ${passingChecks}/${attempt.evidence.checks.length}`,
			);
		}
		if (attempt.error) {
			attemptLines.push(`  error: ${safeInline(attempt.error)}`);
		}
		return attemptLines;
	});
	return { lines, latest };
}

function nextUnitAction(
	view: RunView,
	unit: RunUnitView,
	latest: RunAttemptView | undefined,
): string {
	if (latest && isFollowableAttempt(latest)) {
		return `/orchestrate-follow ${safeInline(view.id)} ${safeInline(latest.id)}`;
	}
	if (
		unit.state === "failed" ||
		latest?.state === "failed" ||
		latest?.state === "interrupted"
	) {
		return `/orchestrate-retry ${safeInline(view.id)} ${safeInline(unit.id)}`;
	}
	if (latest) {
		return `/orchestrate-show ${safeInline(view.id)} attempt ${safeInline(latest.id)}`;
	}
	return `/orchestrate-show ${safeInline(view.id)}`;
}

export function renderUnitDetails(view: RunView, unitId: string): string[] {
	const unit = view.units.find((candidate) => candidate.id === unitId);
	if (!unit) {
		throw new Error(`Unknown step ID: ${safeInline(unitId)}`);
	}
	const history = attemptHistoryLines(view, unit.attemptIds);
	return [
		`Step ${safeInline(unit.id)} (${unit.role}): ${safeInline(unit.title)}`,
		`State: ${unit.state} | Attempts: ${unit.attemptIds.length}`,
		`Description: ${safeInline(unit.description)}`,
		`Dependencies: ${displayList(unit.dependencies)}`,
		`Allowed paths: ${displayList(unit.allowedPaths)}`,
		"Acceptance criteria:",
		...bulletLines(unit.acceptanceCriteria),
		"Validation commands:",
		...bulletLines(unit.validationCommands.map(formatCommand)),
		`Integrated commit: ${display(unit.integratedCommit)}`,
		`Integration error: ${display(unit.integrationError)}`,
		"Attempt history:",
		...history.lines,
		`Next: ${nextUnitAction(view, unit, history.latest)}`,
	];
}

export function resolveRunAttempt(
	view: RunView,
	attemptId: string,
): RunAttemptResolution {
	const matches: RunAttemptResolution[] = [
		...view.attempts.flatMap((attempt): RunAttemptResolution[] =>
			attempt.id === attemptId ? [{ kind: "step", attempt }] : [],
		),
		...view.finalValidationAttempts.flatMap(
			(attempt): RunAttemptResolution[] =>
				attempt.id === attemptId ? [{ kind: "final-validation", attempt }] : [],
		),
	];
	const match = matches[0];
	if (!match) {
		throw new Error(`Unknown attempt ID: ${safeInline(attemptId)}`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous attempt ID ${safeInline(attemptId)}: found ${matches
				.map((candidate) =>
					candidate.kind === "step" ? candidate.attempt.role : candidate.kind,
				)
				.join(", ")}`,
		);
	}
	return match;
}

function workerRoleOf(role: RunUnitRole): WorkerRole | undefined {
	switch (role) {
		case "change":
			return "implementation";
		case "review":
			return "review";
		case "repair":
			return "repair";
		default:
			return undefined;
	}
}

function stepAttemptDetailLines(
	view: RunView,
	attempt: RunAttemptView,
): string[] {
	const unit = view.units.find((candidate) => candidate.id === attempt.unitId);
	const lines = [
		`Step: ${safeInline(attempt.unitId)}${unit ? ` - ${safeInline(unit.title)}` : " (missing definition)"}`,
		`Worker: ${display(attempt.workerId, "not assigned")}`,
		`Branch: ${display(attempt.branch)}`,
		`Workspace: ${display(attempt.workspacePath)}`,
		`Base commit: ${display(attempt.baseCommit)}`,
		`Commit: ${display(attempt.commit)}`,
		`Integrated commit: ${display(attempt.integratedCommit)}`,
	];
	if (unit?.review) {
		lines.unshift(
			`Review: round ${unit.review.round}, category ${unit.review.category}`,
		);
	}
	if (unit?.repairRound !== undefined) {
		lines.unshift(`Repair: round ${unit.repairRound}`);
	}
	if (attempt.summary !== undefined) {
		lines.push(`Summary: ${display(attempt.summary)}`);
	}
	if (attempt.findings) {
		lines.push(
			`Findings: ${attempt.findings.length}`,
			...attempt.findings.flatMap((finding) => [
				`- ${safeInline(finding.id)} [${finding.severity}/${finding.confidence}/${finding.status}] ${safeInline(finding.title)}; paths: ${displayList(finding.paths)}`,
				`  Description: ${safeInline(finding.description)}`,
				`  Recommendation: ${safeInline(finding.recommendation)}`,
			]),
		);
	}
	if (attempt.artifactIds && attempt.artifactIds.length > 0) {
		lines.push(`Artifacts: ${displayList(attempt.artifactIds)}`);
	}
	return lines;
}

export function renderAttemptDetails(
	view: RunView,
	attemptId: string,
): string[] {
	const resolution = resolveRunAttempt(view, attemptId);
	const workerRole =
		resolution.kind === "step"
			? workerRoleOf(resolution.attempt.role)
			: undefined;
	const launchPolicy = workerRole
		? workerLaunchPolicy(view.securityPolicy, workerRole)
		: undefined;
	const common = [
		`Attempt ${safeInline(resolution.attempt.id)} (${resolution.kind === "step" ? resolution.attempt.role : "final-validation"})`,
		`State: ${resolution.attempt.state} | Number: ${resolution.attempt.number}`,
		`Started: ${display(resolution.attempt.startedAt)} | Finished: ${display(resolution.attempt.finishedAt, "in progress")}`,
		...(workerRole
			? [
					`Worker authority: ${workerRole}; tools ${launchPolicy?.tools.join(", ") ?? "legacy unrestricted"}; resources ${view.securityPolicy.workers.resourceDiscovery}`,
				]
			: [
					`Validation authority: ${view.securityPolicy.validation.sandbox} sandbox; ${view.securityPolicy.validation.network} network; ${view.securityPolicy.validation.environment}`,
				]),
	];
	const details =
		resolution.kind === "step"
			? stepAttemptDetailLines(view, resolution.attempt)
			: [
					`Integration commit: ${display(resolution.attempt.integrationCommit)}`,
					`Workspace: ${display(resolution.attempt.worktreePath)}`,
				];
	let next: string;
	if (resolution.kind === "step" && isFollowableAttempt(resolution.attempt)) {
		next = `/orchestrate-follow ${safeInline(view.id)} ${safeInline(resolution.attempt.id)}`;
	} else if (resolution.attempt.state === "failed") {
		next =
			resolution.kind === "step" &&
			(view.source === "engine" || resolution.attempt.role === "change")
				? `/orchestrate-retry ${safeInline(view.id)} ${safeInline(resolution.attempt.unitId)}`
				: resolution.kind === "final-validation"
					? `/orchestrate-retry ${safeInline(view.id)}`
					: `/orchestrate-resume ${safeInline(view.id)}`;
	} else if (resolution.attempt.state === "interrupted") {
		next = `/orchestrate-resume ${safeInline(view.id)}`;
	} else {
		next = `/orchestrate-show ${safeInline(view.id)}`;
	}
	return [
		...common,
		...details,
		...blockedWorkerLines(view, resolution.attempt.id),
		`Error: ${display(resolution.attempt.error)}`,
		...renderEvidence(resolution.attempt.evidence),
		`Next: ${next}`,
	];
}
