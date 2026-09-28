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
 * One CalDAV collection synced as a task list, and the tags routed to it.
 *
 * The list is the unit of sync: its id is what `caldav_account` holds in a
 * note's frontmatter and what sync state is keyed by.
 */
export interface CalDavTaskList {
	id: string;
	url: string;
	name: string;
	/** Tasks with any of these tags go here; nested tags (`work/client`) match `work`. */
	tags: string[];
	/** Set once the user has confirmed the first-sync preview for this list. */
	initialSyncCompleted: boolean;
}

/**
 * One CalDAV server login and the lists it syncs.
 *
 * Credentials are deliberately absent: only the username is stored here, and
 * the password lives in Obsidian's SecretStorage via CalDavSecretStore.
 */
export interface CalDavAccountSettings {
	id: string; // Stable id, also namespaces the stored secret
	name: string;
	enabled: boolean;
	serverUrl: string; // Base URL used for discovery
	username: string; // Non-secret half of the credentials
	syncIntervalMinutes: number;
	/** Routed lists in priority order: a task goes to the first whose tags it has. */
	lists: CalDavTaskList[];
	/** Where tasks matching no list's tags go; empty means they are not synced. */
	defaultListId: string;
	/** Tasks with any of these tags are never picked up. */
	excludeTags: string[];
	/** Only tasks inside this folder sync; empty means no folder restriction. */
	scopeFolder: string;
	/** Overrides the status mapping auto-derived from StatusConfig flags. */
	statusOverrides: Record<string, CalDavVTodoStatus>;
	remoteDeletionPolicy: CalDavRemoteDeletionPolicy;
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
	enabled: false, // Stays off until credentials and a list are chosen
	serverUrl: "",
	username: "",
	syncIntervalMinutes: 15,
	lists: [],
	defaultListId: "",
	excludeTags: [],
	scopeFolder: "",
	statusOverrides: {},
	remoteDeletionPolicy: "archive", // Never destroy notes without being asked
};

/** Accounts saved by an older build may lack fields added since. */
export function mergeSettings(loaded: Partial<CalDavSettings> | undefined): CalDavSettings {
	return {
		...DEFAULT_SETTINGS,
		...loaded,
		accounts: (loaded?.accounts ?? []).map(migrateAccount),
	};
}

/** Shapes saved before 0.4.0, when an account was a single list. */
interface LegacyAccountFields {
	collectionUrl?: string;
	scopeTag?: string; // 0.2.0
	scopeTags?: string[]; // 0.3.x
	scopeTagMode?: "include" | "exclude";
	initialSyncCompleted?: boolean;
}

/**
 * A pre-0.4.0 account becomes an account with one list whose id is the old
 * account id, so the `caldav_account` stamped into notes and the sync state
 * keyed by it stay valid. An include filter becomes that list's routing tags;
 * otherwise the list takes everything else and an exclude filter stays one.
 */
function migrateAccount(saved: Partial<CalDavAccountSettings> & LegacyAccountFields): CalDavAccountSettings {
	const { collectionUrl, scopeTag, scopeTags, scopeTagMode, initialSyncCompleted, ...account } = saved;
	const merged = { ...DEFAULT_ACCOUNT, ...account } as CalDavAccountSettings;
	if (saved.lists || !collectionUrl) return merged;

	const tags = scopeTags ?? (scopeTag?.trim() ? [scopeTag.trim()] : []);
	const routed = scopeTagMode !== "exclude" && tags.length > 0;
	merged.lists = [
		{
			id: merged.id,
			url: collectionUrl,
			name: "",
			tags: routed ? tags : [],
			initialSyncCompleted: initialSyncCompleted ?? false,
		},
	];
	merged.defaultListId = routed ? "" : merged.id;
	merged.excludeTags = scopeTagMode === "exclude" ? tags : [];
	return merged;
}
