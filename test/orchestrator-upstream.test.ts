import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OfficialOrchestratorBackend } from "../src/workers/orchestrator-backend.js";

const socketPath = process.env.PI_ORCHESTRATOR_SMOKE_SOCKET;

describe.runIf(Boolean(socketPath))("official orchestrator smoke", () => {
	it("spawns, inspects, lists, and stops a real upstream worker", async () => {
		if (!socketPath) {
			throw new Error("PI_ORCHESTRATOR_SMOKE_SOCKET is required");
		}
		const backend = new OfficialOrchestratorBackend({
			socketPath,
			requestTimeoutMs: 60_000,
		});
		const worker = await backend.spawn({
			cwd: process.cwd(),
			label: `pi-build-conductor:upstream-smoke:${randomUUID()}`,
		});
		try {
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
	}, 90_000);
});
