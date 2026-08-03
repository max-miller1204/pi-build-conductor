import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOrchestrationRun } from "../src/domain/run.js";
import { PLAN_SCHEMA_VERSION, type TaskPlan } from "../src/domain/types.js";
import {
	AUTHORITY_ENVELOPE_SCHEMA_VERSION,
	type AuthorityEnvelope,
	authorityEnvelopeDigest,
	authorityEnvelopeLines,
	EnvelopeValidationError,
	envelopeAllowsMutation,
	envelopeFromApprovedRun,
	envelopeRepository,
	RESERVED_ESCALATION_CONDITIONS,
	readAuthorityEnvelopeDocument,
	validateAuthorityEnvelope,
} from "../src/security/envelope.js";
import { readSecurityPolicy } from "../src/security/policy.js";

const repositoryRoot = "/home/max/pi-worklist";

/** The envelope document a user authors, with every field stated. */
function authoredDocument(): Record<string, unknown> {
	return {
		version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
		outcome: "Publish the versioned inter-extension worklist API",
		acceptanceCriteria: [
			"npm run check passes",
			"The protocol version is documented in docs/protocol.md",
		],
		repositories: [
			{
				root: repositoryRoot,
				mutation: {
					capabilities: [
						"read-repository",
						"mutate-repository",
						"execute-commands",
					],
					allowedPaths: ["src/", "test/", "docs/protocol.md"],
					forbiddenPaths: ["src/generated/"],
				},
			},
		],
		forbiddenActions: [
			"Never publish to npm",
			"Never force-push a shared branch",
		],
		externalEffects: "forbidden",
		sandbox: { workers: "worktree-only", validation: "none" },
		validation: {
			required: [{ command: "npm", args: ["run", "check"] }],
			perChange: true,
		},
		escalation: {
			conditions: [...RESERVED_ESCALATION_CONDITIONS],
			reservedDecisions: ["Choosing the published package name"],
		},
	};
}

function expectIssues(build: () => unknown): string[] {
	try {
		build();
	} catch (error) {
		if (error instanceof EnvelopeValidationError) {
			return error.issues;
		}
		throw error;
	}
	throw new Error("expected the envelope to be rejected");
}

function taskPlan(): TaskPlan {
	return {
		version: PLAN_SCHEMA_VERSION,
		title: "Add the versioned worklist API",
		tasks: [
			{
				id: "service",
				title: "Centralize the application service",
				description: "Route every operation through one service",
				dependencies: [],
				acceptanceCriteria: ["Every tool call routes through the service"],
				allowedPaths: ["src/service/"],
				validationCommands: [{ command: "npm", args: ["test"] }],
			},
			{
				id: "protocol",
				title: "Add the protocol envelope",
				description: "Add deterministic result envelopes",
				dependencies: ["service"],
				acceptanceCriteria: ["Errors are typed and actionable"],
				allowedPaths: ["src/protocol/"],
				validationCommands: [{ command: "npm", args: ["test"] }],
			},
		],
		finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
	};
}

describe("approved authority envelope", () => {
	it("approves exactly the authority a user authored on disk", async () => {
		const directory = await mkdtemp(join(tmpdir(), "envelope-"));
		const documentPath = join(directory, "request.md.envelope.json");
		await writeFile(documentPath, JSON.stringify(authoredDocument(), null, 2));

		const envelope = readAuthorityEnvelopeDocument(
			JSON.parse(await readFile(documentPath, "utf8")),
		);

		expect(envelope.outcome).toBe(
			"Publish the versioned inter-extension worklist API",
		);
		expect(envelope.repositories).toHaveLength(1);
		const repository = envelopeRepository(envelope, repositoryRoot);
		expect(repository?.mutation.capabilities).toEqual([
			"read-repository",
			"mutate-repository",
			"execute-commands",
		]);
		expect(envelope.validation).toEqual({
			required: [{ command: "npm", args: ["run", "check"] }],
			perChange: true,
		});
		expect(envelope.escalation.reservedDecisions).toEqual([
			"Choosing the published package name",
		]);

		const lines = authorityEnvelopeLines(envelope);
		expect(lines).toContain(
			"Outcome: Publish the versioned inter-extension worklist API",
		);
		expect(lines).toContain("    mutable paths: src/, test/, docs/protocol.md");
		expect(lines).toContain("    withheld paths: src/generated/");
		expect(lines.join("\n")).toContain("Never publish to npm");
		for (const condition of RESERVED_ESCALATION_CONDITIONS) {
			expect(lines.join("\n")).toContain(`  - ${condition}: `);
		}
	});

	it("answers what the envelope already allows without widening it", () => {
		const envelope = validateAuthorityEnvelope(authoredDocument());
		const scope = envelopeRepository(envelope, repositoryRoot)?.mutation;
		if (!scope) {
			throw new Error("expected the approved repository");
		}

		expect(envelopeAllowsMutation(scope, "src/index.ts")).toBe(true);
		expect(envelopeAllowsMutation(scope, "docs/protocol.md")).toBe(true);
		// Withheld inside an approved subtree.
		expect(envelopeAllowsMutation(scope, "src/generated/schema.ts")).toBe(
			false,
		);
		// Never approved at all.
		expect(envelopeAllowsMutation(scope, "package.json")).toBe(false);
		// A file allowance approves that file only, not a subtree beneath it.
		expect(envelopeAllowsMutation(scope, "docs/protocol.md.bak")).toBe(false);
		expect(envelopeRepository(envelope, "/home/max/other")).toBeUndefined();
	});

	it("narrows to the least authority when optional fields are absent", () => {
		const envelope = validateAuthorityEnvelope({
			version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
			outcome: "Investigate the worklist protocol",
			acceptanceCriteria: ["The open questions are answered"],
			repositories: [{ root: repositoryRoot }],
			sandbox: { validation: "none" },
			validation: { required: [{ command: "npm", args: ["test"] }] },
		});

		expect(envelope.repositories[0]?.mutation).toEqual({
			capabilities: ["read-repository"],
			allowedPaths: [],
			forbiddenPaths: [],
		});
		expect(envelope.forbiddenActions).toEqual([]);
		expect(envelope.externalEffects).toBe("forbidden");
		// An absent per-change expectation requires validation rather than waiving it.
		expect(envelope.validation.perChange).toBe(true);
		expect(envelope.escalation.conditions).toEqual([
			...RESERVED_ESCALATION_CONDITIONS,
		]);
	});

	it("refuses to approve away a reserved decision", () => {
		const document = authoredDocument();
		document.escalation = {
			conditions: RESERVED_ESCALATION_CONDITIONS.filter(
				(condition) => condition !== "skip-required-validation",
			),
		};

		expect(expectIssues(() => validateAuthorityEnvelope(document))).toEqual([
			"escalation.conditions must reserve every condition, and omits skip-required-validation",
		]);
	});

	it("refuses a second repository until parent orchestration lands", () => {
		const document = authoredDocument();
		document.repositories = [
			...(document.repositories as unknown[]),
			{ root: "/home/max/pi-build-conductor" },
		];

		expect(expectIssues(() => validateAuthorityEnvelope(document))).toEqual([
			"repositories may name only one repository; adding another is an escalation this orchestrator cannot yet satisfy",
		]);
	});

	it("rejects mutation authority that is stated inconsistently", () => {
		const readOnlyWithPaths = expectIssues(() =>
			validateAuthorityEnvelope({
				...authoredDocument(),
				repositories: [
					{
						root: repositoryRoot,
						mutation: {
							capabilities: ["read-repository"],
							allowedPaths: ["src/"],
						},
					},
				],
			}),
		);
		expect(readOnlyWithPaths).toEqual([
			"repositories[0].mutation.allowedPaths requires the mutate-repository capability",
		]);

		const mutateWithoutPaths = expectIssues(() =>
			validateAuthorityEnvelope({
				...authoredDocument(),
				repositories: [
					{
						root: repositoryRoot,
						mutation: {
							capabilities: ["read-repository", "mutate-repository"],
							allowedPaths: [],
						},
					},
				],
			}),
		);
		expect(mutateWithoutPaths).toEqual([
			"repositories[0].mutation.allowedPaths must name at least one path when mutate-repository is granted",
		]);

		const unreadable = expectIssues(() =>
			validateAuthorityEnvelope({
				...authoredDocument(),
				repositories: [
					{
						root: repositoryRoot,
						mutation: {
							capabilities: ["mutate-repository"],
							allowedPaths: ["src/"],
						},
					},
				],
			}),
		);
		expect(unreadable).toEqual([
			"repositories[0].mutation.capabilities must grant read-repository before granting any other capability",
		]);
	});

	it("rejects an approved path a forbidden path entirely withholds", () => {
		const issues = expectIssues(() =>
			validateAuthorityEnvelope({
				...authoredDocument(),
				repositories: [
					{
						root: repositoryRoot,
						mutation: {
							capabilities: ["read-repository", "mutate-repository"],
							allowedPaths: ["src/generated/"],
							forbiddenPaths: ["src/"],
						},
					},
				],
			}),
		);

		expect(issues).toEqual([
			"repositories[0].mutation.allowedPaths[0] is entirely withheld by forbiddenPaths",
		]);
	});

	it("rejects unsafe repository roots and unsafe approved paths", () => {
		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({
					...authoredDocument(),
					repositories: [{ root: "pi-worklist" }],
				}),
			),
		).toEqual(["repositories[0].root must be an absolute repository path"]);

		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({
					...authoredDocument(),
					repositories: [{ root: `${repositoryRoot}/` }],
				}),
			),
		).toEqual([
			"repositories[0].root must be normalized without a trailing separator",
		]);

		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({
					...authoredDocument(),
					repositories: [
						{
							root: repositoryRoot,
							mutation: {
								capabilities: ["read-repository", "mutate-repository"],
								allowedPaths: ["../secrets/", ".git/config"],
							},
						},
					],
				}),
			),
		).toEqual([
			"repositories[0].mutation.allowedPaths[0] must be a safe repository-relative file or directory path",
			"repositories[0].mutation.allowedPaths[1] must be normalized and cannot address Git metadata",
		]);
	});

	it("rejects authority no capability profile can enforce", () => {
		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({
					...authoredDocument(),
					externalEffects: "allowed",
				}),
			).at(0),
		).toContain("externalEffects must be forbidden");

		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({
					...authoredDocument(),
					sandbox: { workers: "container", validation: "docker" },
				}),
			),
		).toEqual([
			"sandbox.workers must be worktree-only",
			"sandbox.validation must be either none or nono",
		]);
	});

	it("requires an outcome, a criterion, and a required validation command", () => {
		const issues = expectIssues(() =>
			validateAuthorityEnvelope({
				version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
				outcome: "   ",
				acceptanceCriteria: [],
				repositories: [{ root: repositoryRoot }],
				sandbox: { validation: "none" },
				validation: { required: [] },
			}),
		);

		expect(issues).toEqual([
			"outcome must be a non-empty string",
			"acceptanceCriteria must state at least one criterion the result is judged against",
			"validation.required must be a non-empty array of command objects",
		]);
	});

	it("rejects an unsupported envelope version without coercing it", () => {
		expect(
			expectIssues(() =>
				validateAuthorityEnvelope({ ...authoredDocument(), version: 2 }),
			),
		).toEqual([`version must be ${AUTHORITY_ENVELOPE_SCHEMA_VERSION}`]);
	});

	it("identifies an approved envelope independently of document key order", () => {
		const document = authoredDocument();
		const reordered = Object.fromEntries(
			Object.entries(document).reverse(),
		) as Record<string, unknown>;

		const digest = authorityEnvelopeDigest(validateAuthorityEnvelope(document));
		expect(authorityEnvelopeDigest(validateAuthorityEnvelope(reordered))).toBe(
			digest,
		);

		const widened = validateAuthorityEnvelope({
			...document,
			repositories: [
				{
					root: repositoryRoot,
					mutation: {
						capabilities: [
							"read-repository",
							"mutate-repository",
							"execute-commands",
						],
						allowedPaths: ["src/", "test/", "docs/protocol.md", "package.json"],
						forbiddenPaths: ["src/generated/"],
					},
				},
			],
		});
		expect(authorityEnvelopeDigest(widened)).not.toBe(digest);
	});

	it("states the authority an already approved run approves implicitly", () => {
		const run = createOrchestrationRun({
			id: "run-envelope",
			repositoryRoot,
			baseBranch: "main",
			baseCommit: "a".repeat(40),
			integrationBranch: "conductor/run-envelope/integration",
			request: { sourcePath: "/tmp/request.md", text: "Add the API" },
			securityPolicy: readSecurityPolicy({}),
			plan: taskPlan(),
			maxConcurrentWorkers: 2,
			now: "2026-08-03T00:00:00.000Z",
		});

		const envelope = envelopeFromApprovedRun(run);

		expect(envelope.outcome).toBe("Add the versioned worklist API");
		expect(envelope.acceptanceCriteria).toEqual([
			"Every tool call routes through the service",
			"Errors are typed and actionable",
		]);
		expect(envelope.repositories).toEqual([
			{
				root: repositoryRoot,
				mutation: {
					capabilities: [
						"read-repository",
						"mutate-repository",
						"execute-commands",
					],
					allowedPaths: ["src/service/", "src/protocol/"],
					forbiddenPaths: [],
				},
			},
		]);
		expect(envelope.validation.required).toEqual([
			{ command: "npm", args: ["run", "check"] },
		]);
		expect(envelope.sandbox).toEqual({
			workers: "worktree-only",
			validation: "none",
		});
		// Nothing may be reserved away by reading an old run back.
		expect(envelope.escalation.conditions).toEqual([
			...RESERVED_ESCALATION_CONDITIONS,
		]);
	});

	it("bounds rendered lists rather than printing an unbounded envelope", () => {
		const criteria = Array.from(
			{ length: 12 },
			(_, index) => `Criterion ${index + 1}`,
		);
		const envelope: AuthorityEnvelope = validateAuthorityEnvelope({
			...authoredDocument(),
			acceptanceCriteria: criteria,
		});

		const lines = authorityEnvelopeLines(envelope);
		expect(lines).toContain("  - Criterion 8");
		expect(lines).not.toContain("  - Criterion 9");
		expect(lines).toContain("  - (+4 more)");
	});
});
