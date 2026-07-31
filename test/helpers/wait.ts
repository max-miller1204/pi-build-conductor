import { vi } from "vitest";

/**
 * Polls until an orchestration assertion holds.
 *
 * These suites drive real Git and real child processes across parallel test
 * workers, so `vi.waitFor`'s one second default reports machine load as a
 * failure long before a run is genuinely stuck. The bound is generous for the
 * same reason `vitest.config.ts` raises the test timeouts, and still fails a
 * stalled orchestration well inside the surrounding test timeout.
 */
export function waitForOrchestration<T>(
	assertion: () => T | Promise<T>,
): Promise<T> {
	return vi.waitFor(assertion, { timeout: 15_000, interval: 20 });
}
