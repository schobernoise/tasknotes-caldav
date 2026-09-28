import type { PriorityConfig, StatusConfig } from "../src/tasknotes";

/** TaskNotes' shipped defaults (TaskNotes src/settings/defaults.ts), trimmed to the fields we read. */
export const DEFAULT_STATUSES: StatusConfig[] = [
	{ value: "none", isCompleted: false, order: 0 },
	{ value: "open", isCompleted: false, order: 1 },
	{ value: "in-progress", isCompleted: false, order: 2 },
	{ value: "done", isCompleted: true, order: 3 },
];

export const DEFAULT_PRIORITIES: PriorityConfig[] = [
	{ value: "none", weight: 0 },
	{ value: "low", weight: 1 },
	{ value: "normal", weight: 2 },
	{ value: "high", weight: 3 },
];
