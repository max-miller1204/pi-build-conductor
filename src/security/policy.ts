import { isAbsolute } from "node:path";
import type {
	BlockedWorkerPolicy,
	RunSecurityPolicy,
	ValidationSandboxMode,
	WorkerLaunchPolicy,
	WorkerRole,
} from "../domain/types.js";

const ROLE_TOOLS: Readonly<Record<WorkerRole, readonly string[]>> = {
	implementation: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	review: ["read", "grep", "find", "ls"],
	repair: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

function configuredUiPolicy(env: NodeJS.ProcessEnv): BlockedWorkerPolicy {
	const value = env.PI_BUILD_WORKER_UI_POLICY ?? "decline";
	if (value !== "decline" && value !== "cancel") {
		throw new Error(
			"PI_BUILD_WORKER_UI_POLICY must be either decline or cancel",
		);
	}
	return value;
}

function configuredValidationSandbox(
	env: NodeJS.ProcessEnv,
): ValidationSandboxMode {
	const value = env.PI_BUILD_VALIDATION_SANDBOX ?? "none";
	if (value !== "none" && value !== "nono") {
		throw new Error("PI_BUILD_VALIDATION_SANDBOX must be either none or nono");
	}
	return value;
}

export function readSecurityPolicy(
	env: NodeJS.ProcessEnv = process.env,
): RunSecurityPolicy {
	const sandbox = configuredValidationSandbox(env);
	const sandboxExecutable = env.PI_BUILD_NONO_PATH;
	if (sandbox === "nono") {
		if (!sandboxExecutable || !isAbsolute(sandboxExecutable)) {
			throw new Error(
				"PI_BUILD_NONO_PATH must be an absolute path when PI_BUILD_VALIDATION_SANDBOX=nono",
			);
		}
	} else if (sandboxExecutable !== undefined) {
		throw new Error(
			"PI_BUILD_NONO_PATH requires PI_BUILD_VALIDATION_SANDBOX=nono",
		);
	}
	return {
		version: 1,
		source: "configured",
		workers: {
			isolation: "worktree-only",
			sandbox: "none",
			network: "host",
			toolPolicy: "orchestrator-allowlist-v1",
			resourceDiscovery: "disabled",
			credentialExposure: "host-credentials-available-to-worker",
			uiPolicy: configuredUiPolicy(env),
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
	if (policy.workers.toolPolicy !== "orchestrator-allowlist-v1") {
		return undefined;
	}
	return {
		version: 1,
		role,
		tools: [...ROLE_TOOLS[role]],
		resourceDiscovery: "disabled",
	};
}

export function securityPolicyLines(policy: RunSecurityPolicy): string[] {
	const validationSandbox =
		policy.validation.sandbox === "nono"
			? "Nono sandbox, network blocked"
			: "no OS sandbox, host network available";
	const workerTools =
		policy.workers.toolPolicy === "orchestrator-allowlist-v1"
			? "role allowlists enforced by compatible orchestrator"
			: "legacy unrestricted orchestrator tools";
	return [
		`Policy: v${policy.version} (${policy.source})`,
		`Workers: ${policy.workers.isolation}; ${workerTools}; resources ${policy.workers.resourceDiscovery}; ${policy.workers.network} network`,
		`Worker credentials: ${policy.workers.credentialExposure}; agent tools may access host secrets because workers are not OS-sandboxed`,
		`Validation: ${validationSandbox}; ${policy.validation.environment}`,
		`Blocked worker UI: ${policy.workers.uiPolicy}`,
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
	if (policy.version !== 1) {
		throw new Error(`${path}.version must be 1`);
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
		!["orchestrator-allowlist-v1", "legacy-unrestricted"].includes(
			String(worker.toolPolicy),
		) ||
		!["disabled", "host"].includes(String(worker.resourceDiscovery)) ||
		worker.credentialExposure !== "host-credentials-available-to-worker" ||
		!["decline", "cancel"].includes(String(worker.uiPolicy))
	) {
		throw new Error(`${path}.workers contains an invalid security boundary`);
	}
	if (
		(worker.toolPolicy === "orchestrator-allowlist-v1" &&
			worker.resourceDiscovery !== "disabled") ||
		(worker.toolPolicy === "legacy-unrestricted" &&
			worker.resourceDiscovery !== "host")
	) {
		throw new Error(`${path}.workers contains a contradictory tool policy`);
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
