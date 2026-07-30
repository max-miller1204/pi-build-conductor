import { spawnSync } from "node:child_process";
import process from "node:process";

const allowedAdvisory = {
	name: "brace-expansion",
	url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
	node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
	trackingIssue: "https://github.com/earendil-works/pi/issues/7090",
};
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

function isAllowed(vulnerability) {
	return (
		vulnerability.name === allowedAdvisory.name &&
		vulnerability.severity === "high" &&
		vulnerability.nodes?.length === 1 &&
		vulnerability.nodes[0] === allowedAdvisory.node &&
		vulnerability.via?.length === 1 &&
		typeof vulnerability.via[0] === "object" &&
		vulnerability.via[0].severity === "high" &&
		vulnerability.via[0].range === "<=5.0.7" &&
		vulnerability.via[0].url === allowedAdvisory.url
	);
}

const vulnerabilities = Object.values(report.vulnerabilities);
const blocking = vulnerabilities.filter(
	(vulnerability) =>
		(severityRank.get(vulnerability.severity) ?? Number.POSITIVE_INFINITY) >=
			severityRank.get("high") && !isAllowed(vulnerability),
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
	const ignored = vulnerabilities.filter(isAllowed);
	for (const vulnerability of ignored) {
		process.stdout.write(
			`Allowed known upstream advisory ${allowedAdvisory.url} at ${vulnerability.nodes[0]}; tracked at ${allowedAdvisory.trackingIssue}.\n`,
		);
	}
	process.stdout.write(
		"No non-allowlisted high-severity vulnerabilities found.\n",
	);
}
