import { isAbsolute } from "node:path";
import { orchestratorConfigurationValue } from "../configuration.js";
import type {
	BlockedWorkerPolicy,
	CapabilityProfile,
	CapabilityProfileName,
	RunSecurityPolicy,
	ValidationSandboxMode,
	WorkerLaunchPolicy,
	WorkerRole,
	WorkerUiRequest,
	WorkerUiResponse,
} from "../domain/types.js";
import {
	assertCapabilityProfiles,
	defaultCapabilityProfiles,
} from "./capabilities.js";

// Version 1 policies predate frozen capability profiles; their launch
// authority resolves from these historical fixed-role allowlists.
const ROLE_TOOLS: Readonly<Record<WorkerRole, readonly string[]>> = {
	implementation: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	review: ["read", "grep", "find", "ls"],
	repair: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

// The frozen profile each historical worker role draws its authority from.
const ROLE_PROFILES: Readonly<Record<WorkerRole, CapabilityProfileName>> = {
	implementation: "change",
	review: "review",
	repair: "repair",
};

// Runs persisted before the server migration name the same allowlist policy.
function isWorkerAllowlistPolicy(value: unknown): boolean {
	return (
		value === "server-allowlist-v1" || value === "orchestrator-allowlist-v1"
	);
}

function configuredUiPolicy(env: NodeJS.ProcessEnv): BlockedWorkerPolicy {
	const resolved = orchestratorConfigurationValue("WORKER_UI_POLICY", env);
	const value = resolved?.value ?? "decline";
	if (value !== "decline" && value !== "cancel") {
		throw new Error(
			`${resolved?.name ?? "PI_ORCHESTRATOR_WORKER_UI_POLICY"} must be either decline or cancel`,
		);
	}
	return value;
}

function configuredValidationSandbox(
	env: NodeJS.ProcessEnv,
): ValidationSandboxMode {
	const resolved = orchestratorConfigurationValue("VALIDATION_SANDBOX", env);
	const value = resolved?.value ?? "none";
	if (value !== "none" && value !== "nono") {
		throw new Error(
			`${resolved?.name ?? "PI_ORCHESTRATOR_VALIDATION_SANDBOX"} must be either none or nono`,
		);
	}
	return value;
}

export function readSecurityPolicy(
	env: NodeJS.ProcessEnv = process.env,
): RunSecurityPolicy {
	const sandbox = configuredValidationSandbox(env);
	const nonoPath = orchestratorConfigurationValue("NONO_PATH", env);
	const sandboxExecutable = nonoPath?.value;
	if (sandbox === "nono") {
		if (!sandboxExecutable || !isAbsolute(sandboxExecutable)) {
			throw new Error(
				`${nonoPath?.name ?? "PI_ORCHESTRATOR_NONO_PATH"} must be an absolute path when PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono`,
			);
		}
	} else if (sandboxExecutable !== undefined) {
		throw new Error(
			`${nonoPath?.name ?? "PI_ORCHESTRATOR_NONO_PATH"} requires PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono`,
		);
	}
	return {
		version: 2,
		source: "configured",
		workers: {
			isolation: "worktree-only",
			sandbox: "none",
			network: "host",
			toolPolicy: "server-allowlist-v1",
			resourceDiscovery: "disabled",
			credentialExposure: "host-credentials-available-to-worker",
			uiPolicy: configuredUiPolicy(env),
			// Frozen at run creation: later upgrades or configuration changes
			// can never alter the authority an approved run executes with.
			capabilityProfiles: defaultCapabilityProfiles(),
		},
		validation: {
			sandbox,
			network: sandbox === "nono" ? "blocked" : "host",
			environment: "temporary-home-reduced",
			...(sandboxExecutable ? { sandboxExecutable } : {}),
		},
	};
}

export function legacySecurityPolicy(
	uiPolicy: BlockedWorkerPolicy = "decline",
): RunSecurityPolicy {
	return {
		version: 1,
		source: "legacy-migrated",
		workers: {
			isolation: "worktree-only",
			sandbox: "none",
			network: "host",
			toolPolicy: "legacy-unrestricted",
			resourceDiscovery: "host",
			credentialExposure: "host-credentials-available-to-worker",
			uiPolicy,
		},
		validation: {
			sandbox: "none",
			network: "host",
			environment: "temporary-home-reduced",
		},
	};
}

export function workerLaunchPolicy(
	policy: RunSecurityPolicy,
	role: WorkerRole,
): WorkerLaunchPolicy | undefined {
	if (!isWorkerAllowlistPolicy(policy.workers.toolPolicy)) {
		return undefined;
	}
	// Version 2 policies resolve worker authority from the profile snapshot
	// frozen into the run; only version 1 policies fall back to the
	// historical fixed-role defaults.
	const frozenProfile =
		policy.workers.capabilityProfiles?.[ROLE_PROFILES[role]];
	return {
		version: 1,
		role,
		tools: frozenProfile ? [...frozenProfile.tools] : [...ROLE_TOOLS[role]],
		resourceDiscovery: "disabled",
	};
}

/**
 * The launch authority of one workflow step: its role policy narrowed to the
 * tools the step's own capability profile grants. Narrowing is an
 * intersection, so a step can only ever hold less authority than its role.
 */
export function stepWorkerLaunchPolicy(
	policy: RunSecurityPolicy,
	role: WorkerRole,
	profile: CapabilityProfile,
): WorkerLaunchPolicy | undefined {
	const rolePolicy = workerLaunchPolicy(policy, role);
	if (!rolePolicy) {
		return undefined;
	}
	const granted = new Set(profile.tools);
	return {
		...rolePolicy,
		tools: rolePolicy.tools.filter((tool) => granted.has(tool)),
	};
}

/**
 * The response a blocked worker receives. UI requests can never expand
 * authority, so the run policy answers them without involving the user.
 */
export function blockedWorkerResponse(
	policy: BlockedWorkerPolicy,
	request: WorkerUiRequest,
): WorkerUiResponse {
	if (policy === "decline" && request.method === "confirm") {
		return { kind: "confirmation", confirmed: false };
	}
	return { kind: "cancelled" };
}

export function securityPolicyLines(policy: RunSecurityPolicy): string[] {
	const validationSandbox =
		policy.validation.sandbox === "nono"
			? "Nono sandbox, network blocked"
			: "no OS sandbox, host network available";
	const workerTools = isWorkerAllowlistPolicy(policy.workers.toolPolicy)
		? "role allowlists enforced by compatible server"
		: "legacy unrestricted server tools";
	return [
		`Policy: v${policy.version} (${policy.source})`,
		`Workers: ${policy.workers.isolation}; ${workerTools}; resources ${policy.workers.resourceDiscovery}; ${policy.workers.network} network`,
		`Worker credentials: ${policy.workers.credentialExposure}; agent tools may access host secrets because workers are not OS-sandboxed`,
		`Validation: ${validationSandbox}; ${policy.validation.environment}`,
		`Blocked worker UI: ${policy.workers.uiPolicy}`,
		...(policy.workers.capabilityProfiles
			? [
					"Worker authority: capability profiles frozen at run creation; external effects forbidden",
				]
			: []),
	];
}

export function assertRunSecurityPolicy(
	value: unknown,
	path = "run.securityPolicy",
): asserts value is RunSecurityPolicy {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	const policy = value as Record<string, unknown>;
	if (policy.version !== 1 && policy.version !== 2) {
		throw new Error(`${path}.version must be 1 or 2`);
	}
	if (policy.source !== "configured" && policy.source !== "legacy-migrated") {
		throw new Error(`${path}.source is invalid`);
	}
	const workers = policy.workers;
	if (
		typeof workers !== "object" ||
		workers === null ||
		Array.isArray(workers)
	) {
		throw new Error(`${path}.workers must be an object`);
	}
	const worker = workers as Record<string, unknown>;
	if (
		worker.isolation !== "worktree-only" ||
		worker.sandbox !== "none" ||
		worker.network !== "host" ||
		(!isWorkerAllowlistPolicy(worker.toolPolicy) &&
			worker.toolPolicy !== "legacy-unrestricted") ||
		!["disabled", "host"].includes(String(worker.resourceDiscovery)) ||
		worker.credentialExposure !== "host-credentials-available-to-worker" ||
		!["decline", "cancel"].includes(String(worker.uiPolicy))
	) {
		throw new Error(`${path}.workers contains an invalid security boundary`);
	}
	if (
		(isWorkerAllowlistPolicy(worker.toolPolicy) &&
			worker.resourceDiscovery !== "disabled") ||
		(worker.toolPolicy === "legacy-unrestricted" &&
			worker.resourceDiscovery !== "host")
	) {
		throw new Error(`${path}.workers contains a contradictory tool policy`);
	}
	if (policy.version === 2) {
		assertCapabilityProfiles(
			worker.capabilityProfiles,
			`${path}.workers.capabilityProfiles`,
		);
	} else if (worker.capabilityProfiles !== undefined) {
		throw new Error(
			`${path}.workers.capabilityProfiles requires policy version 2`,
		);
	}
	const validation = policy.validation;
	if (
		typeof validation !== "object" ||
		validation === null ||
		Array.isArray(validation)
	) {
		throw new Error(`${path}.validation must be an object`);
	}
	const boundary = validation as Record<string, unknown>;
	if (
		!["none", "nono"].includes(String(boundary.sandbox)) ||
		!["host", "blocked"].includes(String(boundary.network)) ||
		boundary.environment !== "temporary-home-reduced"
	) {
		throw new Error(`${path}.validation contains an invalid security boundary`);
	}
	if (boundary.sandbox === "nono") {
		if (
			typeof boundary.sandboxExecutable !== "string" ||
			!isAbsolute(boundary.sandboxExecutable) ||
			boundary.network !== "blocked"
		) {
			throw new Error(
				`${path}.validation Nono sandbox requires an absolute executable and blocked network`,
			);
		}
	} else if (
		boundary.sandboxExecutable !== undefined ||
		boundary.network !== "host"
	) {
		throw new Error(
			`${path}.validation unsandboxed mode requires host network and no sandbox executable`,
		);
	}
}
