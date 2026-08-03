import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { formatCommand } from "../domain/command-format.js";
import {
	addIssue,
	isRecord,
	type PlanValidationIssue,
	readCommandObject,
	readNonEmptyString,
	readSafeRepositoryPaths,
	readStringArray,
} from "../domain/dag.js";
import { pathIsAllowed } from "../domain/paths.js";
import { readWorkflowPlanDocument } from "../domain/plan-translation.js";
import { type StepDefinition, stepCapabilities } from "../domain/steps.js";
import {
	type OrchestrationRun,
	type RunCapabilityProfiles,
	type RunSecurityPolicy,
	STEP_CAPABILITIES,
	type StepCapability,
	type ValidationCommand,
	type ValidationSandboxMode,
} from "../domain/types.js";
import type { WorkflowRunState } from "../engine/workflow-state.js";
import {
	EXTERNAL_EFFECT_BOUNDARY,
	stepCapabilityProfile,
} from "./capabilities.js";

export const AUTHORITY_ENVELOPE_SCHEMA_VERSION = 1 as const;

/**
 * The decisions an autonomous session may never take on its own authority.
 * Reaching one pauses the run for renewed user approval instead of widening
 * the envelope, so this set is a floor: an approved envelope may never
 * declare fewer conditions than these.
 */
export const RESERVED_ESCALATION_CONDITIONS = [
	"add-repository",
	"widen-mutation-authority",
	"change-acceptance-criteria",
	"skip-required-validation",
	"external-effect",
] as const;

export type EscalationCondition =
	(typeof RESERVED_ESCALATION_CONDITIONS)[number];

/**
 * Where an envelope came from. An authored envelope is a forward promise a
 * user made and is held to completeness; a derived one describes authority a
 * plan already carries and must stay faithful to it instead.
 */
export type EnvelopeSource = "authored" | "derived";

/** One bounded sentence naming what each reserved condition withholds. */
export const ESCALATION_CONDITION_DESCRIPTIONS: Record<
	EscalationCondition,
	string
> = {
	"add-repository": "work in a repository this envelope does not name",
	"widen-mutation-authority":
		"mutate a path or exercise a capability this envelope does not grant",
	"change-acceptance-criteria":
		"add, drop, or reinterpret an approved acceptance criterion",
	"skip-required-validation": "settle without a required validation command",
	"external-effect": "deploy, publish, administer, or mutate anything remote",
};

/** The capabilities the run may exercise, and the paths it may mutate. */
export interface EnvelopeMutationScope {
	capabilities: StepCapability[];
	/** Repository-relative mutable paths; empty when the scope is read-only. */
	allowedPaths: string[];
	/** Paths withheld from mutation even inside an approved subtree. */
	forbiddenPaths: string[];
}

export interface EnvelopeRepository {
	/** The absolute repository root the user named. */
	root: string;
	mutation: EnvelopeMutationScope;
}

export interface EnvelopeValidationExpectations {
	/** Commands that must pass before the objective can be reported met. */
	required: ValidationCommand[];
	/** Whether every mutating step must validate before it integrates. */
	perChange: boolean;
}

export interface EnvelopeSandboxPolicy {
	workers: "worktree-only";
	validation: ValidationSandboxMode;
}

export interface EnvelopeEscalationPolicy {
	conditions: EscalationCondition[];
	/** Further decisions this user reserved, in their own words. */
	reservedDecisions: string[];
}

/**
 * The authority a user approves once, before the work is known. It is the
 * single source the frozen capability profiles, path locks, and validation
 * expectations derive from, so a session can choose its own steps without
 * ever choosing its own authority.
 */
export interface AuthorityEnvelope {
	version: typeof AUTHORITY_ENVELOPE_SCHEMA_VERSION;
	outcome: string;
	acceptanceCriteria: string[];
	repositories: EnvelopeRepository[];
	forbiddenActions: string[];
	externalEffects: "forbidden";
	sandbox: EnvelopeSandboxPolicy;
	validation: EnvelopeValidationExpectations;
	escalation: EnvelopeEscalationPolicy;
}

export class EnvelopeValidationError extends Error {
	readonly issues: string[];
	readonly details: PlanValidationIssue[];

	constructor(details: PlanValidationIssue[]) {
		super(
			`Invalid authority envelope:\n- ${details.map((issue) => issue.message).join("\n- ")}`,
		);
		this.name = "EnvelopeValidationError";
		this.issues = details.map((issue) => issue.message);
		this.details = details;
	}
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	issues: PlanValidationIssue[],
): void {
	const recognized = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!recognized.has(key)) {
			const keyPath = path.length > 0 ? `${path}.${key}` : key;
			addIssue(
				issues,
				"unknown_key",
				keyPath,
				`${keyPath} is not a recognized authority envelope field`,
			);
		}
	}
}

function readUniqueStrings(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string[] {
	const values = readStringArray(value, path, issues);
	if (new Set(values).size !== values.length) {
		addIssue(
			issues,
			"duplicate_entry",
			path,
			`${path} must not contain duplicates`,
		);
	}
	return values;
}

function readRepositoryRoot(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
	source: EnvelopeSource,
): string {
	if (source === "derived") {
		if (typeof value !== "string" || value.length === 0) {
			addIssue(
				issues,
				"repository_root",
				path,
				`${path} must preserve the historical run's non-empty repository identity`,
			);
			return "";
		}
		// Historical roots are identities the run already uses. Normalizing or
		// trimming one here would make envelopeRepository disagree with that run.
		return value;
	}
	const root = readNonEmptyString(value, path, issues);
	if (root.length === 0) {
		return root;
	}
	if (!isAbsolute(root) || root.includes("\0")) {
		addIssue(
			issues,
			"repository_root",
			path,
			`${path} must be an absolute repository path`,
		);
		return root;
	}
	// A non-canonical root compares unequal to the root a run actually opens,
	// so an envelope naming one would silently fail to authorize the other.
	// The root names a directory on this machine, so it normalizes by this
	// platform's rules rather than by both.
	const canonical = normalize(root).replace(/[\\/]+$/, "") || root;
	if (canonical !== root) {
		addIssue(
			issues,
			"non_canonical_root",
			path,
			`${path} must be normalized without a trailing separator`,
		);
	}
	return root;
}

function readCapabilities(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): StepCapability[] {
	// Absent capabilities approve the least authority that can do anything at
	// all, so an incomplete envelope is read-only rather than unrestricted.
	if (value === undefined) {
		return ["read-repository"];
	}
	if (!Array.isArray(value)) {
		addIssue(issues, "capability_array", path, `${path} must be an array`);
		return [];
	}
	const capabilities: StepCapability[] = [];
	for (const [index, entry] of value.entries()) {
		if (!(STEP_CAPABILITIES as readonly unknown[]).includes(entry)) {
			addIssue(
				issues,
				"unknown_capability",
				`${path}[${index}]`,
				`${path}[${index}] must be one of ${STEP_CAPABILITIES.join(", ")}`,
			);
			continue;
		}
		capabilities.push(entry as StepCapability);
	}
	if (new Set(capabilities).size !== capabilities.length) {
		addIssue(
			issues,
			"duplicate_capability",
			path,
			`${path} must not contain duplicates`,
		);
	}
	if (capabilities.length > 0 && !capabilities.includes("read-repository")) {
		addIssue(
			issues,
			"missing_read_capability",
			path,
			`${path} must include read-repository whenever any capability is granted`,
		);
	}
	return orderedCapabilities(capabilities);
}

function orderedCapabilities(
	capabilities: readonly StepCapability[],
): StepCapability[] {
	const requested = new Set(capabilities);
	return STEP_CAPABILITIES.filter((capability) => requested.has(capability));
}

function readMutationScope(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): EnvelopeMutationScope {
	if (value !== undefined && !isRecord(value)) {
		addIssue(issues, "mutation_object", path, `${path} must be an object`);
		return { capabilities: [], allowedPaths: [], forbiddenPaths: [] };
	}
	const scope = value ?? {};
	rejectUnknownKeys(
		scope,
		["capabilities", "allowedPaths", "forbiddenPaths"],
		path,
		issues,
	);
	const capabilities = readCapabilities(
		scope.capabilities,
		`${path}.capabilities`,
		issues,
	);
	const allowedPaths =
		scope.allowedPaths === undefined
			? []
			: readSafeRepositoryPaths(
					scope.allowedPaths,
					`${path}.allowedPaths`,
					issues,
				);
	const forbiddenPaths =
		scope.forbiddenPaths === undefined
			? []
			: readSafeRepositoryPaths(
					scope.forbiddenPaths,
					`${path}.forbiddenPaths`,
					issues,
				);
	const mutates = capabilities.includes("mutate-repository");
	if (mutates && allowedPaths.length === 0) {
		addIssue(
			issues,
			"missing_allowed_paths",
			`${path}.allowedPaths`,
			`${path}.allowedPaths must name at least one path when mutate-repository is granted`,
		);
	}
	if (!mutates && allowedPaths.length > 0) {
		// Paths nothing may write read as approved mutation authority, which is
		// exactly the authority this envelope withheld.
		addIssue(
			issues,
			"unusable_allowed_paths",
			`${path}.allowedPaths`,
			`${path}.allowedPaths requires the mutate-repository capability`,
		);
	}
	for (const [index, allowed] of allowedPaths.entries()) {
		if (pathIsAllowed(allowed, forbiddenPaths)) {
			addIssue(
				issues,
				"cancelled_path",
				`${path}.allowedPaths[${index}]`,
				`${path}.allowedPaths[${index}] is entirely withheld by forbiddenPaths`,
			);
		}
	}
	return { capabilities, allowedPaths, forbiddenPaths };
}

function readRepositories(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
	source: EnvelopeSource,
): EnvelopeRepository[] {
	if (!Array.isArray(value) || value.length === 0) {
		addIssue(
			issues,
			"required_repositories",
			path,
			`${path} must name at least one repository`,
		);
		return [];
	}
	const repositories = value.map((entry, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(entry)) {
			addIssue(
				issues,
				"repository_object",
				itemPath,
				`${itemPath} must be an object`,
			);
			return {
				root: "",
				mutation: { capabilities: [], allowedPaths: [], forbiddenPaths: [] },
			};
		}
		rejectUnknownKeys(entry, ["root", "mutation"], itemPath, issues);
		return {
			root: readRepositoryRoot(entry.root, `${itemPath}.root`, issues, source),
			mutation: readMutationScope(
				entry.mutation,
				`${itemPath}.mutation`,
				issues,
			),
		};
	});
	if (
		new Set(repositories.map((entry) => entry.root)).size !==
		repositories.length
	) {
		addIssue(
			issues,
			"duplicate_repository",
			path,
			`${path} must not name a repository twice`,
		);
	}
	if (repositories.length > 1) {
		// Multi-repository parent orchestration does not exist yet, so an
		// envelope that approved a second repository would approve authority
		// nothing enforces. Adding one stays an escalation the orchestrator
		// refuses until parent runs land.
		addIssue(
			issues,
			"unsupported_repository_count",
			path,
			`${path} may name only one repository; adding another is an escalation this orchestrator cannot yet satisfy`,
		);
	}
	return repositories;
}

function readSandbox(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): EnvelopeSandboxPolicy {
	if (!isRecord(value)) {
		addIssue(issues, "sandbox_object", path, `${path} must be an object`);
		return { workers: "worktree-only", validation: "none" };
	}
	rejectUnknownKeys(value, ["workers", "validation"], path, issues);
	if (value.workers !== undefined && value.workers !== "worktree-only") {
		addIssue(
			issues,
			"worker_isolation",
			`${path}.workers`,
			`${path}.workers must be worktree-only`,
		);
	}
	if (value.validation !== "none" && value.validation !== "nono") {
		addIssue(
			issues,
			"validation_sandbox",
			`${path}.validation`,
			`${path}.validation must be either none or nono`,
		);
		return { workers: "worktree-only", validation: "none" };
	}
	return { workers: "worktree-only", validation: value.validation };
}

function readValidationExpectations(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): EnvelopeValidationExpectations {
	if (!isRecord(value)) {
		addIssue(issues, "validation_object", path, `${path} must be an object`);
		return { required: [], perChange: true };
	}
	rejectUnknownKeys(value, ["required", "perChange"], path, issues);
	let required: ValidationCommand[] = [];
	if (value.required !== undefined) {
		if (!Array.isArray(value.required)) {
			addIssue(
				issues,
				"command_array",
				`${path}.required`,
				`${path}.required must be an array of command objects`,
			);
		} else {
			required = value.required.map((item, index) => {
				const itemPath = `${path}.required[${index}]`;
				if (isRecord(item)) {
					rejectUnknownKeys(item, ["command", "args"], itemPath, issues);
				}
				return readCommandObject(item, itemPath, issues);
			});
		}
	}
	if (value.perChange !== undefined && typeof value.perChange !== "boolean") {
		addIssue(
			issues,
			"per_change_flag",
			`${path}.perChange`,
			`${path}.perChange must be a boolean`,
		);
	}
	// An absent expectation requires validation rather than waiving it.
	return { required, perChange: value.perChange !== false };
}

function readEscalation(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): EnvelopeEscalationPolicy {
	if (value !== undefined && !isRecord(value)) {
		addIssue(issues, "escalation_object", path, `${path} must be an object`);
		return {
			conditions: [...RESERVED_ESCALATION_CONDITIONS],
			reservedDecisions: [],
		};
	}
	const escalation = value ?? {};
	rejectUnknownKeys(
		escalation,
		["conditions", "reservedDecisions"],
		path,
		issues,
	);
	const reservedDecisions =
		escalation.reservedDecisions === undefined
			? []
			: readUniqueStrings(
					escalation.reservedDecisions,
					`${path}.reservedDecisions`,
					issues,
				);
	if (escalation.conditions === undefined) {
		return {
			conditions: [...RESERVED_ESCALATION_CONDITIONS],
			reservedDecisions,
		};
	}
	if (!Array.isArray(escalation.conditions)) {
		addIssue(
			issues,
			"escalation_array",
			`${path}.conditions`,
			`${path}.conditions must be an array`,
		);
		return {
			conditions: [...RESERVED_ESCALATION_CONDITIONS],
			reservedDecisions,
		};
	}
	for (const [index, entry] of escalation.conditions.entries()) {
		if (
			!(RESERVED_ESCALATION_CONDITIONS as readonly unknown[]).includes(entry)
		) {
			addIssue(
				issues,
				"unknown_escalation",
				`${path}.conditions[${index}]`,
				`${path}.conditions[${index}] must be one of ${RESERVED_ESCALATION_CONDITIONS.join(", ")}`,
			);
		}
	}
	// The reserved set is a floor. Listing a subset is an attempt to approve
	// away a decision that stays the user's, so it fails rather than normalizes.
	const declared = new Set(escalation.conditions);
	const missing = RESERVED_ESCALATION_CONDITIONS.filter(
		(condition) => !declared.has(condition),
	);
	if (missing.length > 0) {
		addIssue(
			issues,
			"missing_escalation",
			`${path}.conditions`,
			`${path}.conditions must reserve every condition, and omits ${missing.join(", ")}`,
		);
	}
	return { conditions: [...RESERVED_ESCALATION_CONDITIONS], reservedDecisions };
}

function normalizeAuthorityEnvelope(
	value: unknown,
	source: EnvelopeSource,
): AuthorityEnvelope {
	const issues: PlanValidationIssue[] = [];
	if (!isRecord(value)) {
		throw new EnvelopeValidationError([
			{
				code: "envelope_object",
				path: "envelope",
				message: "envelope must be an object",
			},
		]);
	}
	rejectUnknownKeys(
		value,
		[
			"version",
			"outcome",
			"acceptanceCriteria",
			"repositories",
			"forbiddenActions",
			"externalEffects",
			"sandbox",
			"validation",
			"escalation",
		],
		"",
		issues,
	);
	if (value.version !== AUTHORITY_ENVELOPE_SCHEMA_VERSION) {
		addIssue(
			issues,
			"unsupported_envelope_version",
			"version",
			`version must be ${AUTHORITY_ENVELOPE_SCHEMA_VERSION}`,
		);
	}
	const outcome = readNonEmptyString(value.outcome, "outcome", issues);
	const acceptanceCriteria = readUniqueStrings(
		value.acceptanceCriteria,
		"acceptanceCriteria",
		issues,
	);
	const repositories = readRepositories(
		value.repositories,
		"repositories",
		issues,
		source,
	);
	const forbiddenActions =
		value.forbiddenActions === undefined
			? []
			: readUniqueStrings(value.forbiddenActions, "forbiddenActions", issues);
	if (
		value.externalEffects !== undefined &&
		value.externalEffects !== "forbidden"
	) {
		addIssue(
			issues,
			"external_effects",
			"externalEffects",
			`externalEffects must be forbidden. ${EXTERNAL_EFFECT_BOUNDARY}`,
		);
	}
	const sandbox = readSandbox(value.sandbox, "sandbox", issues);
	const validation = readValidationExpectations(
		value.validation,
		"validation",
		issues,
	);
	const escalation = readEscalation(value.escalation, "escalation", issues);
	const mutates = repositories.some((repository) =>
		repository.mutation.capabilities.includes("mutate-repository"),
	);
	// A forward mutation promise without a final check would widen authority by
	// letting the run settle without evidence. Valid historical mutating plans
	// already require final validation, so derived read-back remains faithful.
	if (source === "authored" && mutates && validation.required.length === 0) {
		addIssue(
			issues,
			"required_commands",
			"validation.required",
			"validation.required must be a non-empty array of command objects when mutate-repository is granted",
		);
	}
	if (issues.length > 0) {
		throw new EnvelopeValidationError(issues);
	}
	return {
		version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
		outcome,
		acceptanceCriteria,
		repositories,
		forbiddenActions,
		externalEffects: "forbidden",
		sandbox,
		validation,
		escalation,
	};
}

/**
 * Validates and normalizes an authored authority envelope. Every absent
 * optional field resolves to the least authority that field can express, so
 * an incomplete envelope narrows the run rather than widening it.
 */
export function validateAuthorityEnvelope(value: unknown): AuthorityEnvelope {
	return normalizeAuthorityEnvelope(value, "authored");
}

/**
 * Reads an envelope document a user authored. Other versions fail with a
 * typed issue rather than being coerced into the current schema.
 */
export function readAuthorityEnvelopeDocument(
	value: unknown,
): AuthorityEnvelope {
	return validateAuthorityEnvelope(value);
}

/**
 * Revalidates an envelope read back from storage under the source it was
 * frozen with, so a stored derived envelope is held to the same rules it was
 * created under rather than to an authored promise's completeness.
 */
export function validateStoredAuthorityEnvelope(
	value: unknown,
	source: EnvelopeSource,
): AuthorityEnvelope {
	return normalizeAuthorityEnvelope(value, source);
}

/** The repository entry an envelope approves for this root, if any. */
export function envelopeRepository(
	envelope: AuthorityEnvelope,
	root: string,
): EnvelopeRepository | undefined {
	return envelope.repositories.find((entry) => entry.root === root);
}

/**
 * Whether the envelope already approves mutating this repository-relative
 * path. A forbidden path withholds mutation even inside an approved subtree.
 */
export function envelopeAllowsMutation(
	scope: EnvelopeMutationScope,
	path: string,
): boolean {
	return (
		scope.capabilities.includes("mutate-repository") &&
		pathIsAllowed(path, scope.allowedPaths) &&
		!pathIsAllowed(path, scope.forbiddenPaths)
	);
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

/**
 * A stable identity for one approved envelope. Freezing this digest with a
 * run is what later proves the authority a session executes under is the
 * authority the user approved, whatever order the document declared it in.
 */
export function authorityEnvelopeDigest(envelope: AuthorityEnvelope): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(envelope)))
		.digest("hex");
}

/**
 * The effective authority of one step: the capabilities the frozen profiles
 * actually grant it, rather than the ones its declaration asked for.
 */
export function effectiveStepCapabilities(
	step: StepDefinition,
	profiles: RunCapabilityProfiles | undefined,
): StepCapability[] {
	return profiles
		? stepCapabilityProfile(profiles, step).capabilities
		: stepCapabilities(step);
}

/** The execution record an envelope can be read back from. */
export interface DerivableRun {
	repositoryRoot: string;
	/** A task plan or workflow plan document, in either schema. */
	plan: unknown;
	capabilityProfiles?: RunCapabilityProfiles;
	sandbox: EnvelopeSandboxPolicy;
}

/**
 * The envelope a plan implies: the outcome, criteria, paths, capabilities,
 * sandboxing, and validation its steps already carry, stated as one object.
 *
 * This is a read-back of authority a plan describes, so it is normalized as
 * `derived` and stays faithful to that plan rather than being held to the
 * completeness an authored promise requires.
 */
export function deriveAuthorityEnvelope(run: DerivableRun): AuthorityEnvelope {
	const plan = readWorkflowPlanDocument(run.plan);
	const effectiveCapabilities = plan.steps.map((step) => ({
		step,
		capabilities: effectiveStepCapabilities(step, run.capabilityProfiles),
	}));
	const capabilities = orderedCapabilities(
		effectiveCapabilities.flatMap((entry) => entry.capabilities),
	);
	const allowedPaths = [
		...new Set(
			effectiveCapabilities.flatMap(({ step, capabilities: stepAuthority }) =>
				step.kind === "change" && stepAuthority.includes("mutate-repository")
					? step.allowedPaths
					: [],
			),
		),
	];
	const acceptanceCriteria = [
		...new Set(
			plan.steps.flatMap((step) =>
				step.kind === "change" ? step.acceptanceCriteria : [],
			),
		),
	];
	return normalizeAuthorityEnvelope(
		{
			version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
			outcome: plan.title,
			acceptanceCriteria,
			repositories: [
				{
					root: run.repositoryRoot,
					mutation: {
						capabilities,
						allowedPaths: capabilities.includes("mutate-repository")
							? allowedPaths
							: [],
						forbiddenPaths: [],
					},
				},
			],
			externalEffects: "forbidden",
			sandbox: run.sandbox,
			validation: {
				required: plan.finalValidationCommands,
				perChange: true,
			},
		},
		"derived",
	);
}

/** The sandbox boundary a run's security policy approves. */
export function envelopeSandboxPolicy(
	securityPolicy: RunSecurityPolicy,
): EnvelopeSandboxPolicy {
	return {
		workers: securityPolicy.workers.isolation,
		validation: securityPolicy.validation.sandbox,
	};
}

/**
 * The envelope an approved run implies. A run created before the envelope
 * became the source has no frozen envelope, so its authority is still only
 * readable back from the plan its user approved step by step.
 */
export function envelopeFromApprovedRun(
	run: OrchestrationRun,
): AuthorityEnvelope {
	return deriveAuthorityEnvelope({
		repositoryRoot: run.repositoryRoot,
		plan: run.plan,
		...(run.securityPolicy.workers.capabilityProfiles
			? { capabilityProfiles: run.securityPolicy.workers.capabilityProfiles }
			: {}),
		sandbox: envelopeSandboxPolicy(run.securityPolicy),
	});
}

/**
 * The envelope an engine run executes under: the frozen one when the run
 * carries it, and otherwise the one its generalized workflow plan implies.
 */
export function envelopeFromWorkflowRun(
	state: WorkflowRunState,
	securityPolicy: RunSecurityPolicy,
): AuthorityEnvelope {
	return (
		state.authority?.envelope ??
		deriveAuthorityEnvelope({
			repositoryRoot: state.repositoryRoot,
			plan: state.plan,
			capabilityProfiles: state.capabilityProfiles,
			sandbox: envelopeSandboxPolicy(securityPolicy),
		})
	);
}

function renderAuthoredScalar(value: string): string {
	return JSON.stringify(value);
}

function renderedList(label: string, entries: readonly string[]): string[] {
	if (entries.length === 0) {
		return [`${label}: none`];
	}
	return [
		`${label}:`,
		...entries.map((entry) => `  - ${renderAuthoredScalar(entry)}`),
	];
}

function renderedPaths(label: string, entries: readonly string[]): string[] {
	return [
		`    ${label}:`,
		...entries.map((entry) => `      - ${renderAuthoredScalar(entry)}`),
	];
}

function renderedCommands(commands: readonly ValidationCommand[]): string[] {
	if (commands.length === 0) {
		return ["Required validation: []"];
	}
	return [
		"Required validation:",
		...commands.map(
			(command) => `  - ${renderAuthoredScalar(formatCommand(command))}`,
		),
	];
}

/**
 * The exact authority a user approves, as reviewable lines. Everything a
 * session may do appears here, and everything reserved appears beside it.
 */
export function authorityEnvelopeLines(envelope: AuthorityEnvelope): string[] {
	const mutates = envelope.repositories.some((repository) =>
		repository.mutation.capabilities.includes("mutate-repository"),
	);
	const acceptanceCriteria =
		mutates && envelope.acceptanceCriteria.length === 0
			? ["Acceptance criteria: none stated by this plan"]
			: renderedList("Acceptance criteria", envelope.acceptanceCriteria);
	const repositories = envelope.repositories.flatMap((repository) => {
		const scope = repository.mutation;
		return [
			`  ${renderAuthoredScalar(repository.root)}`,
			`    capabilities: ${scope.capabilities.join(", ") || "none"}`,
			...(scope.capabilities.includes("mutate-repository")
				? renderedPaths("mutable paths", scope.allowedPaths)
				: ["    mutable paths: none (read-only)"]),
			...(scope.forbiddenPaths.length > 0
				? renderedPaths("withheld paths", scope.forbiddenPaths)
				: []),
		];
	});
	return [
		`Outcome: ${renderAuthoredScalar(envelope.outcome)}`,
		...acceptanceCriteria,
		"Repositories:",
		...repositories,
		...renderedList("Forbidden actions", envelope.forbiddenActions),
		`Sandbox: workers ${envelope.sandbox.workers}; validation ${envelope.sandbox.validation === "nono" ? "Nono sandbox, network blocked" : "no OS sandbox, host network available"}`,
		...renderedCommands(envelope.validation.required),
		`Per-change validation: ${envelope.validation.perChange ? "required before integration" : "not required"}`,
		"Reserved for the user, always escalated:",
		...envelope.escalation.conditions.map(
			(condition) =>
				`  - ${condition}: ${ESCALATION_CONDITION_DESCRIPTIONS[condition]}`,
		),
		...envelope.escalation.reservedDecisions.map(
			(decision) => `  - reserved: ${renderAuthoredScalar(decision)}`,
		),
		EXTERNAL_EFFECT_BOUNDARY,
	];
}
