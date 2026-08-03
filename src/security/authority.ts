import { readFile } from "node:fs/promises";
import { formatCommand } from "../domain/command-format.js";
import { pathIsAllowed } from "../domain/paths.js";
import { readWorkflowPlanDocument } from "../domain/plan-translation.js";
import type { StepDefinition, WorkflowPlan } from "../domain/steps.js";
import {
	CAPABILITY_PROFILE_NAMES,
	type RunCapabilityProfiles,
	type RunSecurityPolicy,
	type StepCapability,
	type ValidationCommand,
} from "../domain/types.js";
import {
	CAPABILITY_PROFILE_MAXIMA,
	capabilityProfileFor,
} from "./capabilities.js";
import {
	type AuthorityEnvelope,
	authorityEnvelopeDigest,
	deriveAuthorityEnvelope,
	type EnvelopeMutationScope,
	type EnvelopeSource,
	type EscalationCondition,
	effectiveStepCapabilities,
	envelopeRepository,
	envelopeSandboxPolicy,
	readAuthorityEnvelopeDocument,
	validateStoredAuthorityEnvelope,
} from "./envelope.js";

/**
 * The approved authority one run executes under, frozen when the run is
 * created. The digest identifies the exact envelope the user approved, so a
 * later reader can prove the authority in force is still that one.
 */
export interface FrozenAuthority {
	source: EnvelopeSource;
	digest: string;
	envelope: AuthorityEnvelope;
}

/** One way a plan asks for authority its run's envelope does not grant. */
export interface AuthorityIssue {
	code: string;
	path: string;
	message: string;
	/** The reserved decision this would take, when it is one of them. */
	condition?: EscalationCondition;
}

export class AuthorityViolationError extends Error {
	readonly issues: string[];
	readonly details: AuthorityIssue[];

	constructor(details: AuthorityIssue[]) {
		super(
			`Plan exceeds the approved authority envelope:\n- ${details
				.map((issue) => issue.message)
				.join("\n- ")}`,
		);
		this.name = "AuthorityViolationError";
		this.issues = details.map((issue) => issue.message);
		this.details = details;
	}
}

function addIssue(issues: AuthorityIssue[], issue: AuthorityIssue): void {
	issues.push(issue);
}

/**
 * The capability profiles an envelope approves: every archetype's maximum
 * authority intersected with the capabilities the user granted for this
 * repository. Nothing a profile holds can exceed the envelope, so narrowing
 * the envelope narrows every worker the run ever launches.
 */
export function capabilityProfilesFromEnvelope(
	envelope: AuthorityEnvelope,
	repositoryRoot: string,
): RunCapabilityProfiles {
	const scope = requireRepositoryScope(envelope, repositoryRoot);
	const granted = new Set(scope.capabilities);
	const profiles = {} as RunCapabilityProfiles;
	for (const name of CAPABILITY_PROFILE_NAMES) {
		profiles[name] = capabilityProfileFor(
			CAPABILITY_PROFILE_MAXIMA[name].filter((capability) =>
				granted.has(capability),
			),
		);
	}
	return profiles;
}

function requireRepositoryScope(
	envelope: AuthorityEnvelope,
	repositoryRoot: string,
): EnvelopeMutationScope {
	const repository = envelopeRepository(envelope, repositoryRoot);
	if (!repository) {
		throw new AuthorityViolationError([
			{
				code: "repository_not_approved",
				path: "repositoryRoot",
				message: `The approved envelope does not name repository ${repositoryRoot}`,
				condition: "add-repository",
			},
		]);
	}
	return repository.mutation;
}

function sameCommand(
	left: ValidationCommand,
	right: ValidationCommand,
): boolean {
	return (
		left.command === right.command &&
		left.args.length === right.args.length &&
		left.args.every((argument, index) => argument === right.args[index])
	);
}

function capabilityIssues(
	step: StepDefinition,
	index: number,
	granted: ReadonlySet<StepCapability>,
	issues: AuthorityIssue[],
): void {
	// An undeclared capability set means "whatever this step kind may hold",
	// which the envelope narrows silently. Only an explicit declaration can
	// ask for authority the user withheld, and that is refused loudly.
	for (const capability of step.capabilities ?? []) {
		if (!granted.has(capability)) {
			addIssue(issues, {
				code: "capability_not_approved",
				path: `steps[${index}].capabilities`,
				message: `Step ${step.id} declares ${capability}, which the approved envelope does not grant`,
				condition: "widen-mutation-authority",
			});
		}
	}
}

function pathIssues(
	step: StepDefinition,
	index: number,
	scope: EnvelopeMutationScope,
	profiles: RunCapabilityProfiles | undefined,
	issues: AuthorityIssue[],
): void {
	if (step.kind !== "change") {
		return;
	}
	if (
		!effectiveStepCapabilities(step, profiles).includes("mutate-repository")
	) {
		// Without mutation authority the step's paths lock scheduling order
		// rather than approving writes, so the envelope has nothing to grant.
		return;
	}
	for (const [pathIndex, path] of step.allowedPaths.entries()) {
		const issuePath = `steps[${index}].allowedPaths[${pathIndex}]`;
		if (!pathIsAllowed(path, scope.allowedPaths)) {
			addIssue(issues, {
				code: "path_not_approved",
				path: issuePath,
				message: `Step ${step.id} would mutate ${path}, which the approved envelope does not allow`,
				condition: "widen-mutation-authority",
			});
			continue;
		}
		if (pathIsAllowed(path, scope.forbiddenPaths)) {
			addIssue(issues, {
				code: "path_withheld",
				path: issuePath,
				message: `Step ${step.id} would mutate ${path}, which the approved envelope withholds`,
				condition: "widen-mutation-authority",
			});
		}
	}
}

function validationIssues(
	plan: WorkflowPlan,
	envelope: AuthorityEnvelope,
	issues: AuthorityIssue[],
): void {
	for (const [index, required] of envelope.validation.required.entries()) {
		if (
			!plan.finalValidationCommands.some((command) =>
				sameCommand(command, required),
			)
		) {
			addIssue(issues, {
				code: "required_validation_missing",
				path: `validation.required[${index}]`,
				message: `The plan never runs the required validation command ${formatCommand(required)}`,
				condition: "skip-required-validation",
			});
		}
	}
	if (!envelope.validation.perChange) {
		return;
	}
	for (const [index, step] of plan.steps.entries()) {
		if (step.kind === "change" && step.validationCommands.length === 0) {
			addIssue(issues, {
				code: "per_change_validation_missing",
				path: `steps[${index}].validationCommands`,
				message: `Step ${step.id} would integrate without the per-change validation the approved envelope requires`,
				condition: "skip-required-validation",
			});
		}
	}
}

/**
 * Every way a plan would exceed the envelope its run is frozen under. The
 * envelope is the source of the run's authority, so this is what makes a plan
 * admissible rather than the other way round.
 */
export function planAuthorityIssues(
	plan: WorkflowPlan,
	envelope: AuthorityEnvelope,
	repositoryRoot: string,
	profiles?: RunCapabilityProfiles,
): AuthorityIssue[] {
	const repository = envelopeRepository(envelope, repositoryRoot);
	if (!repository) {
		return [
			{
				code: "repository_not_approved",
				path: "repositoryRoot",
				message: `The approved envelope does not name repository ${repositoryRoot}`,
				condition: "add-repository",
			},
		];
	}
	const scope = repository.mutation;
	const granted = new Set(scope.capabilities);
	const issues: AuthorityIssue[] = [];
	for (const [index, step] of plan.steps.entries()) {
		capabilityIssues(step, index, granted, issues);
		pathIssues(step, index, scope, profiles, issues);
	}
	validationIssues(plan, envelope, issues);
	return issues;
}

/** Refuses a plan that would exceed the authority its run was frozen under. */
export function assertPlanWithinAuthority(
	plan: WorkflowPlan,
	envelope: AuthorityEnvelope,
	repositoryRoot: string,
	profiles?: RunCapabilityProfiles,
): void {
	const issues = planAuthorityIssues(plan, envelope, repositoryRoot, profiles);
	if (issues.length > 0) {
		throw new AuthorityViolationError(issues);
	}
}

export interface FreezeAuthorityInput {
	repositoryRoot: string;
	/** A task plan or workflow plan document, in either schema. */
	plan: unknown;
	securityPolicy: RunSecurityPolicy;
	/** The envelope the user authored, when they approved one up front. */
	envelope?: AuthorityEnvelope;
}

export interface FrozenRunAuthority {
	authority: FrozenAuthority;
	/** The policy whose capability profiles the envelope derived. */
	securityPolicy: RunSecurityPolicy;
}

/**
 * Freezes the authority one run executes under.
 *
 * An authored envelope is the source: the plan must fit inside it, and the
 * capability profiles the run's workers launch with are derived from it. When
 * no envelope was authored, the plan the user is approving states the same
 * authority implicitly, so it is read back into a derived envelope and the
 * profiles derive from that instead. Either way one object carries the
 * approved authority, and nothing else in the run may exceed it.
 */
export function freezeRunAuthority(
	input: FreezeAuthorityInput,
): FrozenRunAuthority {
	const plan = readWorkflowPlanDocument(input.plan);
	if (input.securityPolicy.version !== 2) {
		// Version 1 policies predate capability profiles, so an envelope would
		// have no frozen snapshot to narrow and nothing would enforce it.
		throw new AuthorityViolationError([
			{
				code: "policy_cannot_enforce_envelope",
				path: "securityPolicy.version",
				message:
					"An approved authority envelope requires security policy version 2, which freezes capability profiles",
			},
		]);
	}
	const envelope =
		input.envelope ??
		deriveAuthorityEnvelope({
			repositoryRoot: input.repositoryRoot,
			plan,
			...(input.securityPolicy.workers.capabilityProfiles
				? {
						capabilityProfiles: input.securityPolicy.workers.capabilityProfiles,
					}
				: {}),
			sandbox: envelopeSandboxPolicy(input.securityPolicy),
		});
	const capabilityProfiles = capabilityProfilesFromEnvelope(
		envelope,
		input.repositoryRoot,
	);
	// A derived envelope is a read-back of this exact plan, so a violation here
	// would mean the derivation and the admission rules disagree.
	assertPlanWithinAuthority(
		plan,
		envelope,
		input.repositoryRoot,
		capabilityProfiles,
	);
	return {
		authority: {
			source: input.envelope ? "authored" : "derived",
			digest: authorityEnvelopeDigest(envelope),
			envelope,
		},
		securityPolicy: {
			...input.securityPolicy,
			workers: { ...input.securityPolicy.workers, capabilityProfiles },
		},
	};
}

/**
 * The authority a revised plan executes under.
 *
 * An authored envelope is frozen: the revised plan must fit inside the
 * authority the user already approved, and widening it is a decision that
 * stays theirs. A derived envelope only ever described the plan it was read
 * back from, so it follows the revision instead of contradicting it.
 */
export function reviseRunAuthority(
	authority: FrozenAuthority,
	input: FreezeAuthorityInput,
): FrozenRunAuthority {
	if (authority.source === "derived") {
		return freezeRunAuthority(input);
	}
	return freezeRunAuthority({ ...input, envelope: authority.envelope });
}

/** Whether the envelope withholds mutating this repository-relative path. */
export function withheldPaths(
	authority: FrozenAuthority | undefined,
	repositoryRoot: string,
): string[] {
	if (!authority) {
		return [];
	}
	const repository = envelopeRepository(authority.envelope, repositoryRoot);
	return [...(repository?.mutation.forbiddenPaths ?? [])];
}

/**
 * Revalidates a frozen authority read back from storage. The digest is
 * recomputed rather than trusted, so an envelope edited on disk fails to load
 * instead of quietly executing under authority nobody approved.
 */
export function validateStoredAuthority(
	value: unknown,
	path: string,
): FrozenAuthority {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	const stored = value as Record<string, unknown>;
	const unknownKeys = Object.keys(stored).filter(
		(key) => !["source", "digest", "envelope"].includes(key),
	);
	if (unknownKeys.length > 0) {
		throw new Error(
			`${path} contains unrecognized fields: ${unknownKeys.join(", ")}`,
		);
	}
	if (stored.source !== "authored" && stored.source !== "derived") {
		throw new Error(`${path}.source must be either authored or derived`);
	}
	const envelope = validateStoredAuthorityEnvelope(
		stored.envelope,
		stored.source,
	);
	const digest = authorityEnvelopeDigest(envelope);
	if (stored.digest !== digest) {
		throw new Error(
			`${path}.digest does not identify the stored envelope, so the approved authority cannot be proven`,
		);
	}
	return { source: stored.source, digest, envelope };
}

/**
 * Asserts that the frozen profiles are the ones the envelope approves and
 * that the stored plan still fits inside it. Both are read checks because a
 * loaded run drives real repository operations under this authority.
 */
export function assertStoredAuthorityConsistency(
	authority: FrozenAuthority,
	input: {
		repositoryRoot: string;
		plan: WorkflowPlan;
		capabilityProfiles: RunCapabilityProfiles;
		path: string;
	},
): void {
	const expected = capabilityProfilesFromEnvelope(
		authority.envelope,
		input.repositoryRoot,
	);
	if (JSON.stringify(expected) !== JSON.stringify(input.capabilityProfiles)) {
		throw new Error(
			`${input.path} capability profiles must be the ones the approved envelope grants`,
		);
	}
	const issues = planAuthorityIssues(
		input.plan,
		authority.envelope,
		input.repositoryRoot,
		input.capabilityProfiles,
	);
	if (issues.length > 0) {
		throw new Error(
			`${input.path} plan exceeds the approved authority envelope: ${issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
}

/** The sidecar file an authored envelope is read from beside a request. */
export function envelopeSidecarPath(requestPath: string): string {
	return `${requestPath}.envelope.json`;
}

/**
 * Reads the authority envelope a user authored beside their request. An
 * absent sidecar means no envelope was approved up front; an unreadable or
 * invalid one fails loudly rather than falling back to wider authority.
 */
export async function readEnvelopeSidecar(
	requestPath: string,
): Promise<AuthorityEnvelope | undefined> {
	const sidecarPath = envelopeSidecarPath(requestPath);
	let text: string;
	try {
		text = await readFile(sidecarPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw new Error(`Failed to read envelope sidecar ${sidecarPath}`, {
			cause: error,
		});
	}
	try {
		return readAuthorityEnvelopeDocument(JSON.parse(text));
	} catch (error) {
		throw new Error(`Failed to load envelope sidecar ${sidecarPath}`, {
			cause: error,
		});
	}
}
