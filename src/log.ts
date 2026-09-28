export interface LogContext {
	category?: string;
	operation?: string;
	details?: unknown;
	error?: unknown;
}

export interface Logger {
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, context?: LogContext): void;
}

/** Flipped by the "Debug logging" setting. */
export const logConfig = { debug: false };

export function createLogger(tag: string): Logger {
	const prefix = `[tasknotes-caldav] ${tag}:`;
	return {
		debug: (message, context) => {
			if (logConfig.debug) console.debug(prefix, message, context ?? "");
		},
		info: (message, context) => console.info(prefix, message, context ?? ""),
		warn: (message, context) => console.warn(prefix, message, context ?? ""),
		error: (message, context) => console.error(prefix, message, context ?? ""),
	};
}
