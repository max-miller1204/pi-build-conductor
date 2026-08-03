import { spawnSync } from "node:child_process";
import process from "node:process";

const allowedVulnerabilities = [
	{
		name: "brace-expansion",
		severity: "high",
		node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
		advisories: [
			{
				severity: "high",
				range: ">=4.0.0 <5.0.8",
				url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
			},
			{
				severity: "high",
				range: ">=4.0.0 <5.0.9",
				url: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
			},
		],
		upstreamReference: "https://github.com/earendil-works/pi/issues/7090",
	},
	{
		name: "undici",
		severity: "high",
		node: "node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
		advisories: [
			{
				severity: "moderate",
				range: ">=8.0.0 <8.9.0",
				url: "https://github.com/advisories/GHSA-8xcm-r25x-g524",
			},
			{
				severity: "high",
				range: ">=8.0.0 <8.9.0",
				url: "https://github.com/advisories/GHSA-4cwx-7wf7-3272",
			},
			{
				severity: "moderate",
				range: ">=8.0.0 <8.9.0",
				url: "https://github.com/advisories/GHSA-m8rv-5g2x-5cg5",
			},
			{
				severity: "moderate",
				range: ">=8.0.0 <8.9.0",
				url: "https://github.com/advisories/GHSA-jr45-8vmc-qm54",
			},
			{
				severity: "moderate",
				range: ">=8.0.0 <8.9.0",
				url: "https://github.com/advisories/GHSA-v3r7-h72x-cjcm",
			},
		],
		upstreamReference:
			"https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/package.json",
	},
];
const severityRank = new Map([
	["info", 0],
	["low", 1],
	["moderate", 2],
	["high", 3],
	["critical", 4],
]);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const audit = spawnSync(npm, ["audit", "--json", "--audit-level=high"], {
	encoding: "utf8",
	maxBuffer: 10 * 1024 * 1024,
});
if (audit.error) {
	throw audit.error;
}

let report;
try {
	report = JSON.parse(audit.stdout);
} catch (error) {
	throw new Error(
		`npm audit did not return valid JSON:\n${audit.stderr || audit.stdout}`,
		{ cause: error },
	);
}
if (
	report.auditReportVersion !== 2 ||
	!report.vulnerabilities ||
	typeof report.vulnerabilities !== "object"
) {
	throw new Error("npm audit returned an unsupported report format");
}
if (audit.status !== 0 && audit.status !== 1) {
	throw new Error(
		`npm audit failed with status ${audit.status}:\n${audit.stderr || audit.stdout}`,
	);
}

function matchesAdvisories(actual, expected) {
	if (
		!Array.isArray(actual) ||
		actual.length !== expected.length ||
		actual.some((advisory) => advisory === null || typeof advisory !== "object")
	) {
		return false;
	}
	const signature = (advisory) =>
		JSON.stringify([advisory.severity, advisory.range, advisory.url]);
	const actualSignatures = actual.map(signature).sort();
	const expectedSignatures = expected.map(signature).sort();
	return actualSignatures.every(
		(actualSignature, index) => actualSignature === expectedSignatures[index],
	);
}

function allowedVulnerability(vulnerability) {
	return allowedVulnerabilities.find(
		(allowed) =>
			vulnerability.name === allowed.name &&
			vulnerability.severity === allowed.severity &&
			vulnerability.nodes?.length === 1 &&
			vulnerability.nodes[0] === allowed.node &&
			matchesAdvisories(vulnerability.via, allowed.advisories),
	);
}

const vulnerabilities = Object.values(report.vulnerabilities);
const blocking = vulnerabilities.filter(
	(vulnerability) =>
		(severityRank.get(vulnerability.severity) ?? Number.POSITIVE_INFINITY) >=
			severityRank.get("high") && !allowedVulnerability(vulnerability),
);
if (blocking.length > 0) {
	process.stderr.write(
		`npm audit found ${blocking.length} non-allowlisted high-severity vulnerability entries:\n`,
	);
	for (const vulnerability of blocking) {
		const advisories = vulnerability.via
			?.filter((via) => typeof via === "object")
			.map((via) => via.url)
			.filter(Boolean);
		process.stderr.write(
			`- ${vulnerability.name} (${vulnerability.severity})${advisories?.length ? `: ${advisories.join(", ")}` : ""}\n`,
		);
	}
	process.exitCode = 1;
} else {
	const ignored = vulnerabilities.filter(allowedVulnerability);
	for (const vulnerability of ignored) {
		const allowed = allowedVulnerability(vulnerability);
		process.stdout.write(
			`Allowed known upstream advisories for ${vulnerability.name} at ${vulnerability.nodes[0]}; upstream reference ${allowed.upstreamReference}.\n`,
		);
	}
	process.stdout.write(
		"No non-allowlisted high-severity vulnerabilities found.\n",
	);
}
