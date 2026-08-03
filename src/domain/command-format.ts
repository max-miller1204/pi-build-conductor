import type { ValidationCommand } from "./types.js";

const SIMPLE_ARGUMENT = /^[A-Za-z0-9_./:@%+=,-]+$/;

function quoteArgument(value: string): string {
	return value.length > 0 && SIMPLE_ARGUMENT.test(value)
		? value
		: JSON.stringify(value);
}

export function formatCommand(command: ValidationCommand): string {
	return [command.command, ...command.args].map(quoteArgument).join(" ");
}
