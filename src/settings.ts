/**
 * What happens locally when a task's VTODO disappears from the server.
 *
 * Defaults to `archive`: nothing is destroyed, but the task leaves the active
 * list. Deleting notes is not reversible from inside Obsidian, so it is opt-in.
 */
export type CalDavRemoteDeletionPolicy = "archive" | "delete" | "unlink";

/** VTODO STATUS values, for the per-status override table. */
export type CalDavVTodoStatus = "NEEDS-ACTION" | "IN-PROCESS" | "COMPLETED" | "CANCELLED";

/**
 * One CalDAV collection synced as a task list.
 *
 * Credentials are deliberately absent: only the username is stored here, and
 * the password lives in Obsidian's SecretStorage via CalDavSecretStore.
 */
export interface CalDavAccountSettings {
	id: string; // Stable id, also namespaces the stored secret
	name: string;
	enabled: boolean;
	serverUrl: string; // Base URL used for discovery
	collectionUrl: string; // The chosen VTODO collection
	username: string; // Non-secret half of the credentials
	syncIntervalMinutes: number;
	/** Tag filter; empty means no tag restriction. */
	scopeTags: string[];
	/** `include`: sync only tasks with one of `scopeTags`. `exclude`: sync all tasks without them. */
	scopeTagMode: "include" | "exclude";
	/** Only tasks inside this folder sync; empty means no folder restriction. */
	scopeFolder: string;
	/** Overrides the status mapping auto-derived from StatusConfig flags. */
	statusOverrides: Record<string, CalDavVTodoStatus>;
	remoteDeletionPolicy: CalDavRemoteDeletionPolicy;
	/** Set once the user has confirmed the first-sync preview for this account. */
	initialSyncCompleted: boolean;
}

export interface CalDavSettings {
	accounts: CalDavAccountSettings[];
	/** Push local edits as they happen rather than waiting for the poll. */
	pushOnChange: boolean;
	/** Debounce before an edit is pushed, so a burst of keystrokes is one write. */
	pushDebounceMs: number;
	/** Send TaskNotes' task-identification tag as a CATEGORY. It is kept on notes either way. */
	syncTaskTag: boolean;
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: CalDavSettings = {
	accounts: [],
	pushOnChange: true,
	pushDebounceMs: 1500,
	syncTaskTag: false, // Every synced task has it, so on the server it is noise
	debugLogging: false,
};

export const DEFAULT_ACCOUNT: Omit<CalDavAccountSettings, "id"> = {
	name: "",
	enabled: false, // Stays off until credentials and a collection are chosen
	serverUrl: "",
	collectionUrl: "",
	username: "",
	syncIntervalMinutes: 15,
	scopeTags: [],
	scopeTagMode: "include",
	scopeFolder: "",
	statusOverrides: {},
	remoteDeletionPolicy: "archive", // Never destroy notes without being asked
	initialSyncCompleted: false,
};

/** Accounts saved by an older build may lack fields added since. */
export function mergeSettings(loaded: Partial<CalDavSettings> | undefined): CalDavSettings {
	return {
		...DEFAULT_SETTINGS,
		...loaded,
		accounts: (loaded?.accounts ?? []).map(migrateAccount),
	};
}

/** 0.2.0 stored a single `scopeTag`; it becomes a one-entry include list. */
function migrateAccount(saved: Partial<CalDavAccountSettings> & { scopeTag?: string }): CalDavAccountSettings {
	const { scopeTag, ...account } = saved;
	const merged = { ...DEFAULT_ACCOUNT, ...account } as CalDavAccountSettings;
	if (scopeTag?.trim() && !saved.scopeTags) merged.scopeTags = [scopeTag.trim()];
	return merged;
}
