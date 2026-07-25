export interface ResolvedConfigurationValue {
	name: string;
	value: string;
}

/**
 * Resolves one orchestrator setting from the environment.
 *
 * The neutral `PI_ORCHESTRATOR_<suffix>` name is authoritative and the legacy
 * `PI_BUILD_<suffix>` name remains a temporary alias. Conflicting values fail
 * closed instead of silently preferring either spelling.
 */
export function orchestratorConfigurationValue(
	suffix: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedConfigurationValue | undefined {
	const neutralName = `PI_ORCHESTRATOR_${suffix}`;
	const legacyName = `PI_BUILD_${suffix}`;
	const neutral = env[neutralName];
	const legacy = env[legacyName];
	if (neutral !== undefined && legacy !== undefined && neutral !== legacy) {
		throw new Error(
			`${neutralName} and ${legacyName} are both set with different values; set only ${neutralName}`,
		);
	}
	if (neutral !== undefined) {
		return { name: neutralName, value: neutral };
	}
	if (legacy !== undefined) {
		return { name: legacyName, value: legacy };
	}
	return undefined;
}
