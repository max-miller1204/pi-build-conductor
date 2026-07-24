import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OfficialServerBackend } from "../src/workers/server-backend.js";

const socketPath = process.env.PI_SERVER_SMOKE_SOCKET;

describe.runIf(Boolean(socketPath))("compatible server service", () => {
	it("negotiates, applies, and reports worker launch policy version 1", async () => {
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
			label: `pi-build-conductor:compatibility:${randomUUID()}`,
			launchPolicy,
		});
		try {
			expect(worker.appliedPolicy).toEqual(launchPolicy);
			await expect(backend.status(worker.id)).resolves.toMatchObject({
				id: worker.id,
				status: "online",
				appliedPolicy: launchPolicy,
			});
			await expect(backend.list()).resolves.toContainEqual(
				expect.objectContaining({ id: worker.id, appliedPolicy: launchPolicy }),
			);
		} finally {
			await backend.stop(worker.id);
		}
	});
});
