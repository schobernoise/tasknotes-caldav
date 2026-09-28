/**
 * The slice of the TaskNotes runtime API (v1) this plugin uses.
 *
 * Hand-copied from TaskNotes `src/types.ts` and `src/api/runtime-api.ts`
 * because the contract is not published as a package. Only fields and methods
 * this plugin touches are declared; widen it here when a new one is needed.
 */

import type { App, EventRef } from "obsidian";

export type TaskDependencyRelType =
	| "FINISHTOSTART"
	| "FINISHTOFINISH"
	| "STARTTOSTART"
	| "STARTTOFINISH";

export interface TaskDependency {
	uid: string;
	reltype: TaskDependencyRelType;
	gap?: string;
}

export interface Reminder {
	id: string;
	type: "absolute" | "relative";
	relatedTo?: "due" | "scheduled";
	offset?: string;
	absoluteTime?: string;
	description?: string;
}

export interface TaskInfo {
	title: string;
	status: string;
	priority: string;
	due?: string;
	scheduled?: string;
	path: string;
	archived: boolean;
	tags?: string[];
	projects?: string[];
	recurrence?: string;
	completedDate?: string;
	dateModified?: string;
	reminders?: Reminder[];
	blockedBy?: TaskDependency[];
}

export interface TaskCreationData extends Partial<TaskInfo> {
	creationContext?: "api" | "import";
	customFrontmatter?: Record<string, unknown>;
}

export interface StatusConfig {
	value: string;
	isCompleted: boolean;
	isSkipped?: boolean;
	order: number;
}

export interface PriorityConfig {
	value: string;
	weight: number;
}

export interface TaskNotesMutationContext {
	source?: string;
	reason?: string;
}

export interface TaskNotesTaskEvent {
	taskPath?: string;
	after?: TaskInfo;
	source?: string;
}

export interface ResolvedTaskDependency {
	dependency: TaskDependency;
	path: string | null;
}

export interface TaskNotesApi {
	readonly apiVersion: number;
	hasCapability(capability: string): boolean;
	readonly tasks: {
		get(path: string): Promise<TaskInfo | null>;
		list(): Promise<TaskInfo[]>;
		create(data: TaskCreationData, context?: TaskNotesMutationContext): Promise<TaskInfo>;
		update(
			path: string,
			patch: Partial<TaskInfo>,
			context?: TaskNotesMutationContext
		): Promise<TaskInfo>;
		delete(path: string, context?: TaskNotesMutationContext): Promise<void>;
		archive(
			path: string,
			archived: boolean,
			context?: TaskNotesMutationContext
		): Promise<TaskInfo>;
	};
	readonly relationships: {
		parents(path: string): Promise<TaskInfo[]>;
		dependencies(path: string): Promise<ResolvedTaskDependency[]>;
	};
	readonly settings: {
		snapshot(): { taskIdentificationMethod: string; taskTag: string };
	};
	readonly catalog: {
		statuses(): StatusConfig[];
		priorities(): PriorityConfig[];
	};
	readonly events: {
		on(event: "task.updated", handler: (event: TaskNotesTaskEvent) => void): EventRef;
		off(ref: EventRef): void;
	};
	readonly lifecycle: {
		ready(): Promise<void>;
		on(event: "unloading", handler: () => void): EventRef;
		off(ref: EventRef): void;
	};
}

/** Tags every mutation we make, so TaskNotes events are traceable to us. */
export const MUTATION_SOURCE = "tasknotes-caldav";

const REQUIRED_CAPABILITIES = [
	"tasks.read",
	"tasks.write",
	"tasks.delete",
	"tasks.events",
	"catalog.read",
	"settings.snapshot",
	"relationships.read",
	"lifecycle.events",
];

export function getTaskNotesApi(app: App): TaskNotesApi {
	const plugins = (app as unknown as {
		plugins: { getPlugin(id: string): { api?: TaskNotesApi } | null };
	}).plugins;
	const api = plugins.getPlugin("tasknotes")?.api;

	if (!api) throw new Error("TaskNotes is not installed or not enabled");
	if (api.apiVersion !== 1) {
		throw new Error(`Unsupported TaskNotes runtime API version ${api.apiVersion}`);
	}
	const missing = REQUIRED_CAPABILITIES.filter((c) => !api.hasCapability(c));
	if (missing.length > 0) {
		throw new Error(`TaskNotes runtime API lacks: ${missing.join(", ")}`);
	}
	return api;
}
