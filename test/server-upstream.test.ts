import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OfficialServerBackend } from "../src/workers/server-backend.js";

const socketPath = process.env.PI_SERVER_SMOKE_SOCKET;

describe.runIf(Boolean(socketPath))("official server smoke", () => {
	it("executes a prompt and manages a real upstream worker lifecycle", async () => {
		if (!socketPath) {
			throw new Error("PI_SERVER_SMOKE_SOCKET is required");
		}
		const backend = new OfficialServerBackend({
			socketPath,
			requestTimeoutMs: 60_000,
		});
		const launchPolicy = {
			version: 1 as const,
			role: "review" as const,
			tools: ["read", "grep", "find", "ls"],
			resourceDiscovery: "disabled" as const,
		};
		await backend.preflightPolicy(launchPolicy);
		const worker = await backend.spawn({
			cwd: process.cwd(),
			label: `pi-build-conductor:upstream-smoke:${randomUUID()}`,
			launchPolicy,
		});
		try {
			const progress: string[] = [];
			const execution = await backend.startPrompt(
				worker.id,
				"Reply with exactly PI_BUILD_CONDUCTOR_SMOKE_OK. Do not use tools.",
				{ onEvent: (event) => progress.push(event.type) },
			);
			const result = await execution.completion;
			expect(result.status).toBe("succeeded");
			if (result.status !== "succeeded") {
				throw new Error(result.error);
			}
			expect(result.output).toContain("PI_BUILD_CONDUCTOR_SMOKE_OK");
			expect(progress).toContain("agent_started");

			const [status, instances] = await Promise.all([
				backend.status(worker.id),
				backend.list(),
			]);
			expect(status.status).toBe("online");
			expect(instances.some((instance) => instance.id === worker.id)).toBe(
				true,
			);
		} finally {
			await backend.stop(worker.id);
		}
	}, 180_000);
});
