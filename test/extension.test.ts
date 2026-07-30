import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createOrchestrationRun } from "../src/domain/run.js";
import extension from "../src/extension.js";
import { GitCli } from "../src/git/git.js";
import { RunStore } from "../src/storage/run-store.js";

const execute = promisify(execFile);
const directories: string[] = [];

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void> | void;

async function repositoryFixture(): Promise<{
	root: string;
	store: RunStore;
	runId: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-build-extension-"));
	directories.push(root);
	await execute("git", ["init", "-b", "main", root]);
	await execute("git", ["config", "user.name", "Test"], { cwd: root });
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	await writeFile(join(root, "README.md"), "# Test\n", "utf8");
	await execute("git", ["add", "README.md"], { cwd: root });
	await execute("git", ["commit", "-m", "Initial"], { cwd: root });
	const repository = await new GitCli().inspect(root);
	const store = new RunStore(
		join(repository.commonDirectory, "pi-build-conductor", "runs"),
	);
	const run = createOrchestrationRun({
		id: "inspect-run",
		repositoryRoot: repository.root,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch: "conductor/inspect-run/integration",
		request: { sourcePath: join(root, "request.md"), text: "Build it" },
		plan: {
			version: 3,
			title: "Inspection fixture",
			tasks: [
				{
					id: "implementation",
					title: "Implement",
					description: "Implement it",
					dependencies: [],
					acceptanceCriteria: ["Done"],
					allowedPaths: ["src/"],
					validationCommands: [{ command: "npm", args: ["test"] }],
				},
			],
			finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
		},
		maxConcurrentWorkers: 2,
		now: "2026-01-01T00:00:00.000Z",
	});
	await store.create(run);
	return { root, store, runId: run.id };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("run inspection extension commands", () => {
	it("registers the complete run inspection and control surface", () => {
		const commands = new Map<string, CommandHandler>();
		extension({
			registerCommand(name: string, options: { handler: CommandHandler }) {
				commands.set(name, options.handler);
			},
		} as unknown as ExtensionAPI);

		expect([...commands.keys()]).toEqual([
			"orchestrate-list",
			"build-list",
			"orchestrate-show",
			"build-show",
			"orchestrate-follow",
			"build-follow",
			"orchestrate-retry",
			"build-retry",
			"orchestrate-prune",
			"build-prune",
			"orchestrate",
			"build",
			"orchestrate-plan",
			"build-plan",
			"orchestrate-investigate",
			"build-investigate",
			"orchestrate-cancel",
			"build-cancel",
			"orchestrate-resume",
			"build-resume",
		]);
	});

	it("marks every legacy /build command as a temporary alias", () => {
		const descriptions = new Map<string, string>();
		extension({
			registerCommand(name: string, options: { description: string }) {
				descriptions.set(name, options.description);
			},
		} as unknown as ExtensionAPI);

		for (const [name, description] of descriptions) {
			if (name.startsWith("build")) {
				const primary = name.replace(/^build/, "orchestrate");
				expect(description).toContain(`temporary alias of /${primary}`);
			} else {
				expect(description).not.toContain("alias");
			}
		}
		expect(descriptions.get("orchestrate-cancel")).toBe(
			"Cancel an orchestration run and stop its active workers",
		);
	});

	it("migrates legacy storage and lists runs through /orchestrate-list", async () => {
		const fixture = await repositoryFixture();
		const commands = new Map<string, CommandHandler>();
		extension({
			registerCommand(name: string, options: { handler: CommandHandler }) {
				commands.set(name, options.handler);
			},
		} as unknown as ExtensionAPI);
		const widgets = new Map<string, string[]>();
		const notifications: string[] = [];
		const ctx = {
			cwd: fixture.root,
			hasUI: false,
			mode: "print",
			ui: {
				setWidget(key: string, lines: string[] | undefined) {
					if (lines) widgets.set(key, lines);
				},
				notify(message: string) {
					notifications.push(message);
				},
				setStatus() {},
			},
		} as unknown as ExtensionCommandContext;

		await commands.get("orchestrate-list")?.("", ctx);
		expect(widgets.get("pi-orchestrator:runs")?.join("\n")).toContain(
			"inspect-run | awaiting_approval",
		);
		const repository = await new GitCli().inspect(fixture.root);
		await readFile(
			join(
				repository.commonDirectory,
				"pi-orchestrator",
				"runs",
				"inspect-run.json",
			),
			"utf8",
		);
		await expect(
			readFile(
				join(
					repository.commonDirectory,
					"pi-build-conductor",
					"runs",
					"inspect-run.json",
				),
				"utf8",
			),
		).rejects.toMatchObject({ code: "ENOENT" });

		await commands.get("orchestrate-show")?.(fixture.runId, ctx);
		expect(widgets.get("pi-orchestrator:inspect-run")?.join("\n")).toContain(
			"Run inspect-run: Inspection fixture",
		);
		expect(notifications).toContain("Showing run inspect-run");
	});

	it("serves the same runs through the temporary /build aliases", async () => {
		const fixture = await repositoryFixture();
		const commands = new Map<string, CommandHandler>();
		extension({
			registerCommand(name: string, options: { handler: CommandHandler }) {
				commands.set(name, options.handler);
			},
		} as unknown as ExtensionAPI);
		const widgets = new Map<string, string[]>();
		const ctx = {
			cwd: fixture.root,
			hasUI: false,
			mode: "print",
			ui: {
				setWidget(key: string, lines: string[] | undefined) {
					if (lines) widgets.set(key, lines);
				},
				notify() {},
				setStatus() {},
			},
		} as unknown as ExtensionCommandContext;

		await commands.get("build-list")?.("", ctx);
		expect(widgets.get("pi-orchestrator:runs")?.join("\n")).toContain(
			"inspect-run | awaiting_approval",
		);
	});
});
