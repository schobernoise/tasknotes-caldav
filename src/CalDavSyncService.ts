/**
 * Two-way CalDAV VTODO sync orchestration.
 *
 * Holds the moving parts that the pure modules under ./caldav/ cannot: vault
 * writes, timers, persisted state and the TaskNotes runtime API. The decisions
 * themselves — what a VTODO looks like, who wins a conflict, what to upload —
 * live in those pure modules and are tested there.
 *
 * Loop prevention is structural: writing `caldav_etag` back into frontmatter
 * re-fires TaskNotes' `task.updated` event, so a content fingerprint that
 * excludes every `caldav_*` key is what stops the cycle. See caldavFingerprint.ts.
 */

import { TFile } from "obsidian";

import type CalDavPlugin from "./main";
import type { CalDavAccountSettings } from "./settings";
import {
	MUTATION_SOURCE,
	type TaskDependency,
	type TaskInfo,
	type TaskNotesApi,
} from "./tasknotes";
import { createLogger } from "./log";
import { CalDavClient, CalDavError } from "./caldav/CalDavClient";
import { CalDavSecretStore } from "./caldav/CalDavSecretStore";
import { CALDAV_FRONTMATTER_KEYS, getCalDavRelevantFingerprint } from "./caldav/caldavFingerprint";
import {
	planFirstSync,
	planIncrementalSync,
	planRemoteDeletion,
	resolveConflict,
	summarizeFirstSyncPlan,
	type FirstSyncPlan,
	type LocalTaskSnapshot,
	type RemoteTodoSnapshot,
} from "./caldav/caldavReconciliation";
import { taskBelongsToCollection, type CalDavCollectionScope } from "./caldav/collectionMembership";
import {
	applyTaskToVTodo,
	readVTodoIntoTaskPatch,
	readVTodoRevision,
	readVTodoUid,
	type VTodoMappingContext,
} from "./caldav/vtodoMapping";
import {
	createVTodoDocument,
	parseVTodoDocument,
	serializeVTodoDocument,
	type VTodoDocument,
} from "./caldav/vtodoDocument";
import { applyReminders, readReminders } from "./caldav/vtodoAlarms";
import { applyRelations, readRelations, type VTodoRelations } from "./caldav/vtodoRelations";

/** How often the retry queue is drained. */
const RETRY_QUEUE_INTERVAL_MS = 60_000;
/** Attempts before a queued push is abandoned, so a rejected task cannot loop forever. */
const MAX_PUSH_ATTEMPTS = 5;
const CONTEXT = { source: MUTATION_SOURCE };

/** A push that failed and is waiting to be retried. */
interface PendingCalDavPush {
	taskPath: string;
	accountId: string;
	requestedAt: number;
	attempts: number;
	lastAttemptAt?: number;
	lastError?: string;
}

interface CalDavCollectionState {
	syncToken?: string;
	/** Last seen collection ctag; equal means nothing changed server-side. */
	ctag?: string;
	lastSyncedAt?: string;
}

interface CalDavResourceIndexEntry {
	accountId: string;
	uid: string;
	path: string;
	href: string;
}

/** Sync bookkeeping persisted next to the settings in this plugin's data.json. */
export interface SyncState {
	fingerprints: Record<string, string>;
	collectionState: Record<string, CalDavCollectionState>;
	resourceIndex: CalDavResourceIndexEntry[];
	syncQueue: PendingCalDavPush[];
}

export const EMPTY_SYNC_STATE: SyncState = {
	fingerprints: {},
	collectionState: {},
	resourceIndex: [],
	syncQueue: [],
};

export class CalDavSyncService {
	private readonly logger = createLogger("CalDavSync");
	private readonly secretStore: CalDavSecretStore;

	private pollTimers = new Map<string, number>();
	private pushTimers = new Map<string, number>();
	/** Paths currently being written by an inbound sync; guards reentrancy. */
	private handlingPaths = new Set<string>();
	/** Tasks whose relations pointed at a target with no UID yet. */
	private pendingRelationPaths = new Set<string>();
	private relationFlushTimers = new Map<string, number>();
	/** Set while replaying deferred relations, to keep the retry to one pass. */
	private flushingRelations = false;
	/** Imported tasks whose relations must wait until every sibling exists. */
	private pendingInboundRelations: { path: string; doc: VTodoDocument }[] = [];
	private inFlightAccounts = new Set<string>();
	private destroyed = false;
	private retryTimer: number | null = null;

	constructor(
		private readonly plugin: CalDavPlugin,
		private readonly api: TaskNotesApi
	) {
		this.secretStore = new CalDavSecretStore(plugin.app.secretStorage);
	}

	private get settings() {
		return this.plugin.data.settings;
	}

	private get state() {
		return this.plugin.data.state;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	initialize(): void {
		this.reschedulePolls();
		this.scheduleRetryDrain();
	}

	/** Restarts poll timers, e.g. after an account was enabled or its interval changed. */
	reschedulePolls(): void {
		for (const timer of this.pollTimers.values()) window.clearTimeout(timer);
		this.pollTimers.clear();
		for (const account of this.enabledAccounts()) {
			this.startPollTimer(account.id);
		}
	}

	destroy(): void {
		this.destroyed = true;
		for (const timer of this.pollTimers.values()) window.clearTimeout(timer);
		for (const timer of this.pushTimers.values()) window.clearTimeout(timer);
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		for (const timer of this.relationFlushTimers.values()) window.clearTimeout(timer);
		this.relationFlushTimers.clear();
		this.pollTimers.clear();
		this.pushTimers.clear();
	}

	private enabledAccounts(): CalDavAccountSettings[] {
		return this.settings.accounts.filter((account) => account.enabled && account.collectionUrl);
	}

	private getAccount(accountId: string): CalDavAccountSettings | undefined {
		return this.settings.accounts.find((account) => account.id === accountId);
	}

	// -----------------------------------------------------------------------
	// Event hooks (wired in main.ts)
	// -----------------------------------------------------------------------

	/**
	 * Reacts to any change to a task file, whether TaskNotes or an external tool
	 * made it. The fingerprint comparison is what distinguishes a real edit from
	 * our own sync-metadata write.
	 */
	async handleTaskUpdated(path: string, updatedTask?: TaskInfo): Promise<void> {
		if (this.destroyed) return;
		if (this.handlingPaths.has(path)) return; // our own inbound write

		const task = updatedTask ?? (await this.api.tasks.get(path));
		if (!task) return;

		const fingerprint = getCalDavRelevantFingerprint(task);
		if (this.state.fingerprints[path] === fingerprint) return; // nothing sync-relevant changed

		const account = this.resolveAccountForTask(task);
		if (!account || !this.settings.pushOnChange) {
			// Out of scope, or waiting for the poll: remember the fingerprint so
			// we do not re-evaluate it on every keystroke.
			await this.recordFingerprint(path, fingerprint);
			return;
		}

		this.schedulePush(account, path);
	}

	/** Deletes the remote VTODO when its task file is removed from the vault. */
	async handleTaskFileDeleted(
		path: string,
		previousFrontmatter?: Record<string, unknown>
	): Promise<void> {
		if (this.destroyed) return;

		const accountId = asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.account]);
		const href = asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.href]);
		const etag = asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.etag]);
		if (!accountId || !href) return;

		const account = this.getAccount(accountId);
		if (!account?.enabled) return;

		try {
			const client = this.createClient(account);
			await client.deleteResource(href, etag ? { ifMatch: etag } : {});
			await this.forgetTask(path);
		} catch (error) {
			this.logError("Failed to delete remote task", error, { operation: "delete-remote" });
		}
	}

	private schedulePush(account: CalDavAccountSettings, path: string): void {
		const existing = this.pushTimers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.pushTimers.delete(path);
			void this.pushIfStillChanged(account.id, path).catch((error: unknown) => {
				this.logError("Failed to push task", error, { operation: "push" });
				// Without this the edit is simply lost until the task is touched
				// again: a transient network failure would silently desync a task.
				void this.enqueueRetry(account.id, path, error);
			});
		}, this.settings.pushDebounceMs);
		this.pushTimers.set(path, timer);
	}

	// -----------------------------------------------------------------------
	// Push (local -> remote)
	// -----------------------------------------------------------------------

	/**
	 * Re-checks the fingerprint when the debounce fires. An edit event can be
	 * scheduled before our own inbound write records its fingerprint — a
	 * TaskNotes rename, for one, announces the new path mid-update — and
	 * pushing then would bounce the pulled content straight back.
	 */
	private async pushIfStillChanged(accountId: string, path: string): Promise<void> {
		const task = await this.api.tasks.get(path);
		if (task && this.state.fingerprints[path] === getCalDavRelevantFingerprint(task)) return;
		await this.pushTask(accountId, path);
	}

	async pushTask(accountId: string, path: string): Promise<void> {
		const account = this.getAccount(accountId);
		if (!account?.enabled || this.destroyed) return;

		const task = await this.api.tasks.get(path);
		const file = this.getFile(path);
		if (!task || !file) return;

		const client = this.createClient(account);
		const snapshot = this.snapshotTask(task, file);
		const uid = snapshot.uid ?? generateUid();
		const href = snapshot.href ?? joinUrl(account.collectionUrl, `${uid}.ics`);

		// Fetch the current resource first so properties we do not model —
		// VALARM, X- properties, DESCRIPTION written on a phone — survive.
		const existing = snapshot.href ? await client.getResource(href) : null;
		const doc =
			(existing?.data ? parseVTodoDocument(existing.data) : null) ?? createVTodoDocument();

		applyTaskToVTodo(doc, task, this.mappingContext(account), { uid });
		const relations = await this.resolveOutboundRelations(task);
		applyRelations(doc, relations.relations);
		applyReminders(doc, task.reminders ?? []);
		const body = serializeVTodoDocument(doc);

		const result = await client.putResource(
			href,
			body,
			snapshot.etag ? { ifMatch: snapshot.etag } : { ifNoneMatch: "*" }
		);

		if (result.conflict) {
			await this.resolveConflictAt(account, path, href, task);
			return;
		}

		await this.stampSyncMetadata(path, { uid, href, etag: result.etag, accountId: account.id });
		await this.indexResource({ accountId: account.id, uid, path, href });

		// A parent pushed moments earlier only gets its UID once its own write
		// lands, so revisit the link rather than leaving the hierarchy missing
		// on the server until the next poll.
		if (relations.unresolved && !this.flushingRelations) {
			this.pendingRelationPaths.add(path);
			this.scheduleRelationFlush(account.id);
		}
	}

	/**
	 * Runs after a 412. The ETag mismatch has already established that both
	 * sides changed; this only decides who wins and applies it.
	 */
	private async resolveConflictAt(
		account: CalDavAccountSettings,
		path: string,
		href: string,
		task: TaskInfo
	): Promise<void> {
		const client = this.createClient(account);
		const current = await client.getResource(href);

		if (!current?.data) {
			// Vanished between the PUT and the GET: treat as a remote deletion.
			await this.applyRemoteDeletion(account, path);
			return;
		}

		const remoteDoc = parseVTodoDocument(current.data);
		if (!remoteDoc) {
			this.logError("Remote resource is not a VTODO", undefined, {
				operation: "resolve-conflict",
			});
			return;
		}

		const file = this.getFile(path);
		if (!file) return;

		const winner = resolveConflict(
			localChangedAtMs(task, file),
			readVTodoRevision(remoteDoc)
		);
		this.logger.info("Resolved CalDAV conflict", {
			operation: "resolve-conflict",
			details: { winner, path },
		});

		if (winner === "local") {
			applyTaskToVTodo(remoteDoc, task, this.mappingContext(account), {
				uid: readVTodoUid(remoteDoc) ?? generateUid(),
			});
			const retry = await client.putResource(href, serializeVTodoDocument(remoteDoc), {
				ifMatch: current.etag,
			});
			if (!retry.conflict) {
				await this.stampSyncMetadata(path, {
					uid: readVTodoUid(remoteDoc) ?? "",
					href,
					etag: retry.etag,
					accountId: account.id,
				});
			}
			return;
		}

		await this.applyRemotePatch(account, path, {
			uid: readVTodoUid(remoteDoc) ?? "",
			url: href,
			etag: current.etag,
			revisionMs: readVTodoRevision(remoteDoc),
			data: current.data,
		});
	}

	// -----------------------------------------------------------------------
	// Pull (remote -> local)
	// -----------------------------------------------------------------------

	/** One polling pass for a single account. Resolves false if it failed (already logged). */
	async syncAccount(accountId: string, options: { force?: boolean } = {}): Promise<boolean> {
		const force = options.force ?? false;
		const account = this.getAccount(accountId);
		if (!account?.enabled || this.destroyed) return true;
		if (this.inFlightAccounts.has(accountId)) return true;

		this.inFlightAccounts.add(accountId);
		try {
			const client = this.createClient(account);
			const state = this.state.collectionState[accountId] ?? {};

			// Collections routinely mix VTODOs with far more VEVENTs, so ask for
			// the change token first and skip everything else when it has not
			// moved. Walking the resource list instead would drag down every
			// event body just to discover none of them are tasks.
			const tag = await client.getCollectionTag(account.collectionUrl);
			const currentTag = tag.ctag ?? tag.syncToken;
			if (currentTag && state.ctag === currentTag && !force) return true;

			// A VTODO-filtered calendar-query returns only tasks, and returns all
			// of them — completeness is what makes deletion detection safe.
			const remotes = await this.fetchRemoteSnapshots(client, account);
			const locals = await this.snapshotAccountTasks(account);
			const plan = planIncrementalSync(locals, remotes, { remotesAreComplete: true });

			for (const remote of plan.toPull) {
				const withData = remotes.find((entry) => entry.uid === remote.uid);
				if (withData) await this.applyRemotePatch(account, undefined, withData);
			}

			for (const conflict of plan.conflicts) {
				if (conflict.winner === "local") {
					await this.pushTask(accountId, conflict.local.path);
				} else {
					const withData = remotes.find((entry) => entry.uid === conflict.remote.uid);
					if (withData) await this.applyRemotePatch(account, conflict.local.path, withData);
				}
			}

			for (const local of plan.remoteDeleted) {
				await this.applyRemoteDeletion(account, local.path);
			}

			for (const local of plan.toPush) {
				await this.pushTask(accountId, local.path);
			}

			await this.flushRelations(account);

			this.state.collectionState[accountId] = {
				syncToken: tag.syncToken ?? state.syncToken,
				ctag: currentTag,
				lastSyncedAt: new Date().toISOString(),
			};
			await this.plugin.saveState();
			return true;
		} catch (error) {
			this.reportSyncError(account, error);
			return false;
		} finally {
			this.inFlightAccounts.delete(accountId);
		}
	}

	/**
	 * Writes a remote VTODO into the vault, either patching the matching task or
	 * creating one. `knownPath` short-circuits the index lookup when the caller
	 * already knows which task this is.
	 */
	private async applyRemotePatch(
		account: CalDavAccountSettings,
		knownPath: string | undefined,
		remote: RemoteSnapshotWithData
	): Promise<void> {
		const doc = parseVTodoDocument(remote.data);
		if (!doc) return;

		const uid = readVTodoUid(doc) ?? remote.uid;
		const patch = readVTodoIntoTaskPatch(doc, this.mappingContext(account));
		const path = knownPath ?? (await this.findPathForUid(account.id, uid));

		if (path) {
			// A title change renames the note when TaskNotes stores titles in
			// filenames, so everything after the update follows the returned path.
			let currentPath = path;
			this.handlingPaths.add(path);
			try {
				const updated = await this.api.tasks.update(
					path,
					{
						...(patch.title !== undefined && { title: patch.title }),
						...(patch.status !== undefined && { status: patch.status }),
						...(patch.priority !== undefined && { priority: patch.priority }),
						due: patch.due ?? undefined,
						scheduled: patch.scheduled ?? undefined,
						completedDate: patch.completedDate ?? undefined,
						...(patch.tags !== undefined && { tags: patch.tags }),
						recurrence: patch.recurrence ?? undefined,
					},
					CONTEXT
				);
				currentPath = updated.path;
				this.handlingPaths.add(currentPath);
				await this.stampSyncMetadata(currentPath, {
					uid,
					href: remote.url,
					etag: remote.etag,
					accountId: account.id,
				});
				if (currentPath !== path) await this.forgetTask(path);
			} finally {
				this.handlingPaths.delete(path);
				this.handlingPaths.delete(currentPath);
			}
			await this.indexResource({ accountId: account.id, uid, path: currentPath, href: remote.url });
			await this.applyInboundRelations(account, currentPath, doc);
			return;
		}

		// New on the server: create through TaskNotes so folder rules, templates
		// and defaults all apply.
		const created = await this.api.tasks.create(
			{
				title: patch.title ?? "Untitled task",
				...(patch.status !== undefined && { status: patch.status }),
				...(patch.priority !== undefined && { priority: patch.priority }),
				// Empty string rather than an omitted key: leaving a date out lets the
				// vault's creation defaults invent one (scheduled defaults to today),
				// and the next push would write that invented date onto the user's
				// remote task. An empty value skips the default and is normalised
				// away again by the creation service.
				due: patch.due ?? "",
				scheduled: patch.scheduled ?? "",
				completedDate: patch.completedDate ?? "",
				recurrence: patch.recurrence ?? "",
				...(patch.tags?.length ? { tags: patch.tags } : {}),
				creationContext: "import",
				// The CalDAV keys are not TaskNotes fields, so they travel as
				// custom frontmatter and land in the file in the same write.
				customFrontmatter: {
					[CALDAV_FRONTMATTER_KEYS.uid]: uid,
					[CALDAV_FRONTMATTER_KEYS.href]: remote.url,
					...(remote.etag ? { [CALDAV_FRONTMATTER_KEYS.etag]: remote.etag } : {}),
					[CALDAV_FRONTMATTER_KEYS.account]: account.id,
					[CALDAV_FRONTMATTER_KEYS.syncedAt]: new Date().toISOString(),
				},
			},
			CONTEXT
		);

		// Fingerprint the task as TaskNotes reads it back, not the creation result:
		// the empty-string dates above are normalised away on read, and a
		// mismatch would bounce the import straight back to the server.
		const stored = await this.api.tasks.get(created.path);
		if (!stored) throw new Error(`TaskNotes did not return the imported task at ${created.path}`);
		await this.recordFingerprint(created.path, getCalDavRelevantFingerprint(stored));
		await this.indexResource({ accountId: account.id, uid, path: created.path, href: remote.url });
		// Deferred: a parent imported later in this same run has no path yet.
		this.pendingInboundRelations.push({ path: created.path, doc });
	}

	/**
	 * Syncs every enabled account now, ignoring the change gate.
	 *
	 * Forced because the point of asking is usually to check a suspicion that
	 * the tokens are lying.
	 */
	async syncAllAccounts(): Promise<{ synced: number; failed: number }> {
		const result = { synced: 0, failed: 0 };
		for (const account of this.enabledAccounts()) {
			if (await this.syncAccount(account.id, { force: true })) result.synced++;
			else result.failed++;
		}
		return result;
	}

	/**
	 * Detaches every task from CalDAV, leaving the notes and the server alone.
	 *
	 * Only the local link is removed; nothing is deleted on either side. The
	 * link is also what makes re-syncing idempotent, so syncing the same list
	 * again after this will duplicate every task — hence the confirmation.
	 *
	 * The set of tasks to clear is taken from the notes as well as the index,
	 * because the notes are the authority and an index can be stale.
	 */
	async unlinkAllTasks(): Promise<number> {
		const paths = new Set(this.state.resourceIndex.map((entry) => entry.path));
		for (const task of await this.api.tasks.list()) {
			if (this.readFrontmatterAt(task.path)?.[CALDAV_FRONTMATTER_KEYS.uid]) {
				paths.add(task.path);
			}
		}

		let unlinked = 0;
		for (const path of paths) {
			if (!this.getFile(path)) continue; // stale index entry
			try {
				await this.clearSyncMetadata(path);

				// Keep the fingerprint rather than forgetting it. Dropping it would
				// make the task look freshly edited, and push-on-change would
				// immediately re-upload it under a new UID — unlinking would undo
				// itself and leave a duplicate behind.
				const task = await this.api.tasks.get(path);
				if (task) await this.recordFingerprint(path, getCalDavRelevantFingerprint(task));

				unlinked++;
			} catch (error) {
				this.logError("Failed to unlink a task from CalDAV", error, {
					operation: "caldav-unlink-all",
					path,
				});
			}
		}

		this.state.resourceIndex = [];
		this.state.collectionState = {};
		this.state.syncQueue = [];
		await this.plugin.saveState();
		return unlinked;
	}

	// -----------------------------------------------------------------------
	// Retry queue
	// -----------------------------------------------------------------------

	private async enqueueRetry(accountId: string, path: string, error: unknown): Promise<void> {
		const existing = this.state.syncQueue.find(
			(entry) => entry.taskPath === path && entry.accountId === accountId
		);
		if (existing) {
			existing.lastError = describeError(error);
		} else {
			this.state.syncQueue.push({
				taskPath: path,
				accountId,
				requestedAt: Date.now(),
				attempts: 0,
				lastError: describeError(error),
			});
		}
		await this.plugin.saveState();
	}

	private scheduleRetryDrain(): void {
		if (this.destroyed || this.retryTimer !== null) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.drainRetryQueue().finally(() => this.scheduleRetryDrain());
		}, RETRY_QUEUE_INTERVAL_MS);
	}

	/** Retries every queued push once, dropping entries that keep failing. */
	async drainRetryQueue(): Promise<void> {
		if (this.destroyed) return;

		const queue = this.state.syncQueue;
		if (queue.length === 0) return;

		const remaining: PendingCalDavPush[] = [];
		for (const entry of queue) {
			const account = this.getAccount(entry.accountId);
			if (!account?.enabled) {
				// Hold rather than drop: the account may simply be switched off
				// for now, and the edit is still worth sending when it returns.
				remaining.push(entry);
				continue;
			}

			try {
				await this.pushTask(entry.accountId, entry.taskPath);
			} catch (error) {
				const attempts = entry.attempts + 1;
				if (attempts >= MAX_PUSH_ATTEMPTS) {
					this.logError("Giving up on a queued CalDAV push", error, {
						operation: "caldav-retry-exhausted",
						path: entry.taskPath,
						attempts,
					});
					continue;
				}
				remaining.push({
					...entry,
					attempts,
					lastAttemptAt: Date.now(),
					lastError: describeError(error),
				});
			}
		}

		// Anything enqueued while this drain was awaiting pushes is not in
		// `queue`, so keep it rather than overwriting with the starting snapshot.
		const enqueuedDuringDrain = this.state.syncQueue.filter(
			(entry) =>
				!queue.some(
					(seen) => seen.taskPath === entry.taskPath && seen.accountId === entry.accountId
				)
		);
		this.state.syncQueue = [...remaining, ...enqueuedDuringDrain];
		await this.plugin.saveState();
	}

	// -----------------------------------------------------------------------
	// Relations
	// -----------------------------------------------------------------------

	/**
	 * Turns a task's vault-link relations into UID relations.
	 *
	 * TaskNotes addresses relations by path while CalDAV addresses them by UID,
	 * so a link can only be expressed once its target has been synced. A target
	 * without a UID is dropped rather than guessed at, and reported back so the
	 * caller can retry after the rest of the run has assigned UIDs. Projects
	 * that are plain notes rather than tasks never appear here at all.
	 */
	private async resolveOutboundRelations(
		task: TaskInfo
	): Promise<{ relations: VTodoRelations; unresolved: boolean }> {
		const parents: string[] = [];
		const dependencies: TaskDependency[] = [];
		let unresolved = false;

		for (const parent of await this.api.relationships.parents(task.path)) {
			const uid = this.uidForPath(parent.path);
			if (uid) parents.push(uid);
			else unresolved = true;
		}

		for (const resolved of await this.api.relationships.dependencies(task.path)) {
			const uid = resolved.path ? this.uidForPath(resolved.path) : undefined;
			if (uid) dependencies.push({ ...resolved.dependency, uid });
			else unresolved = true;
		}

		if (unresolved) {
			// Expected whenever a parent is archived or filtered into another
			// account — not a failure, so not a warning.
			this.logger.debug("Some relations have no CalDAV counterpart yet", {
				operation: "caldav-resolve-relations",
				details: { path: task.path },
			});
		}

		return { relations: { parents, dependencies }, unresolved };
	}

	/**
	 * Writes a remote VTODO's relations and reminders back onto a task.
	 *
	 * Both are non-destructive: a relation whose target is not in this vault, or
	 * an alarm list a foreign client stripped, must not erase what the vault
	 * already holds. Only resolved values are written.
	 */
	private async applyInboundRelations(
		account: CalDavAccountSettings,
		path: string,
		doc: VTodoDocument
	): Promise<void> {
		const { parents, dependencies } = readRelations(doc);
		const reminders = readReminders(doc);

		const projects: string[] = [];
		for (const uid of parents) {
			const parentPath = await this.findPathForUid(account.id, uid);
			const file = parentPath ? this.getFile(parentPath) : null;
			if (file) projects.push(this.wikilink(file, path));
		}

		const blockedBy: TaskDependency[] = [];
		for (const dependency of dependencies) {
			const targetPath = await this.findPathForUid(account.id, dependency.uid);
			const file = targetPath ? this.getFile(targetPath) : null;
			if (file) blockedBy.push({ ...dependency, uid: this.wikilink(file, path) });
		}

		const updates: Partial<TaskInfo> = {};
		if (projects.length > 0) updates.projects = projects;
		if (blockedBy.length > 0) updates.blockedBy = blockedBy;
		if (reminders.length > 0) updates.reminders = reminders;
		if (Object.keys(updates).length === 0) return;

		this.handlingPaths.add(path);
		try {
			await this.api.tasks.update(path, updates, CONTEXT);
		} finally {
			this.handlingPaths.delete(path);
		}
	}

	/**
	 * Applies the relations of freshly imported tasks.
	 *
	 * Deferred to the end of a run because a relation can only be written once
	 * both ends exist in the vault, and imports arrive in server order.
	 */
	private async flushInboundRelations(account: CalDavAccountSettings): Promise<void> {
		const pending = this.pendingInboundRelations;
		this.pendingInboundRelations = [];

		for (const entry of pending) {
			try {
				await this.applyInboundRelations(account, entry.path, entry.doc);
			} catch (error) {
				this.logError("Failed to apply imported relations", error, {
					operation: "caldav-flush-inbound-relations",
					path: entry.path,
				});
			}
		}
	}

	private async flushRelations(account: CalDavAccountSettings): Promise<void> {
		await this.flushInboundRelations(account);
		await this.flushPendingRelations(account.id);
	}

	/**
	 * Queues the deferred relation pass shortly after a push.
	 *
	 * Without this a new subtask shows no parent on the server until the next
	 * poll, which can be a quarter of an hour away.
	 */
	private scheduleRelationFlush(accountId: string): void {
		if (this.destroyed || this.relationFlushTimers.has(accountId)) return;

		const timer = window.setTimeout(() => {
			this.relationFlushTimers.delete(accountId);
			void this.flushPendingRelations(accountId).catch((error: unknown) => {
				this.logError("Failed to replay deferred relations", error, {
					operation: "caldav-flush-relations",
				});
			});
		}, this.settings.pushDebounceMs * 2);
		this.relationFlushTimers.set(accountId, timer);
	}

	/** Re-pushes tasks whose relations could not be addressed on the first pass. */
	private async flushPendingRelations(accountId: string): Promise<void> {
		const paths = [...this.pendingRelationPaths];
		this.pendingRelationPaths.clear();
		if (paths.length === 0) return;

		// Exactly one extra pass: a parent that is still unaddressable is archived
		// or lives in another account, and retrying would never change that.
		this.flushingRelations = true;
		try {
			for (const path of paths) {
				try {
					await this.pushTask(accountId, path);
				} catch (error) {
					this.logError("Failed to push deferred relations", error, {
						operation: "caldav-flush-relations",
						path,
					});
				}
			}
		} finally {
			this.flushingRelations = false;
		}
	}

	private uidForPath(path: string): string | undefined {
		return asString(this.readFrontmatterAt(path)?.[CALDAV_FRONTMATTER_KEYS.uid]);
	}

	/** Frontmatter links must be wikilinks; Obsidian does not resolve markdown links there. */
	private wikilink(target: TFile, sourcePath: string): string {
		return `[[${this.plugin.app.metadataCache.fileToLinktext(target, sourcePath, true)}]]`;
	}

	/** Applies the configured policy when a VTODO disappears from the server. */
	private async applyRemoteDeletion(account: CalDavAccountSettings, path: string): Promise<void> {
		const outcome = planRemoteDeletion(account.remoteDeletionPolicy);
		const task = await this.api.tasks.get(path);
		if (!task) return;

		this.handlingPaths.add(path);
		try {
			if (outcome.action === "delete") {
				await this.api.tasks.delete(path, CONTEXT);
				await this.forgetTask(path);
				return;
			}

			// Archiving can move the note into the archive folder.
			const currentPath =
				outcome.action === "archive" && !task.archived
					? (await this.api.tasks.archive(path, true, CONTEXT)).path
					: path;
			if (outcome.stripSyncMetadata) {
				await this.clearSyncMetadata(currentPath);
			}
			await this.forgetTask(path);
		} finally {
			this.handlingPaths.delete(path);
		}
	}

	// -----------------------------------------------------------------------
	// First sync
	// -----------------------------------------------------------------------

	/** Computes the first-sync plan without writing anything — the dry run. */
	async previewFirstSync(accountId: string): Promise<FirstSyncPlan> {
		const account = this.getAccount(accountId);
		if (!account) throw new Error(`Unknown CalDAV account ${accountId}`);

		const remotes = await this.fetchRemoteSnapshots(this.createClient(account), account);
		const locals = await this.snapshotAccountTasks(account);
		return planFirstSync(locals, remotes);
	}

	/** Applies a plan the user has confirmed. */
	async applyFirstSync(accountId: string, plan: FirstSyncPlan): Promise<void> {
		const account = this.getAccount(accountId);
		if (!account) return;

		for (const local of plan.toUpload) {
			await this.pushTask(accountId, local.path);
		}

		for (const remote of plan.toImport) {
			const withData = remote as RemoteSnapshotWithData;
			if (withData.data) await this.applyRemotePatch(account, undefined, withData);
		}

		for (const pair of plan.toLink) {
			await this.stampSyncMetadata(pair.local.path, {
				uid: pair.remote.uid,
				href: pair.remote.url,
				etag: pair.remote.etag,
				accountId: account.id,
			});
			await this.indexResource({
				accountId: account.id,
				uid: pair.remote.uid,
				path: pair.local.path,
				href: pair.remote.url,
			});
		}

		for (const pair of plan.toResolve) {
			if (pair.winner === "local") {
				await this.pushTask(accountId, pair.local.path);
			} else {
				const withData = pair.remote as RemoteSnapshotWithData;
				if (withData.data) await this.applyRemotePatch(account, pair.local.path, withData);
			}
		}

		// Only now does every task on both sides have both a path and a UID, so
		// this is the first point at which relations can be written at all.
		await this.flushRelations(account);

		this.logger.info("Completed first CalDAV sync", {
			operation: "first-sync",
			details: { accountId, ...summarizeFirstSyncPlan(plan) },
		});
	}

	// -----------------------------------------------------------------------
	// Snapshots and scope
	// -----------------------------------------------------------------------

	private async fetchRemoteSnapshots(
		client: CalDavClient,
		account: CalDavAccountSettings
	): Promise<RemoteSnapshotWithData[]> {
		return (await client.fetchAllVTodos(account.collectionUrl))
			.map((resource) => toRemoteSnapshot(resource.url, resource.etag, resource.data))
			.filter((snapshot): snapshot is RemoteSnapshotWithData => snapshot !== null);
	}

	private async snapshotAccountTasks(account: CalDavAccountSettings): Promise<LocalTaskSnapshot[]> {
		const scope = scopeFor(account);
		const snapshots: LocalTaskSnapshot[] = [];

		for (const task of await this.api.tasks.list()) {
			const file = this.getFile(task.path);
			if (!file) continue;

			const ownedByAccount =
				asString(this.readFrontmatter(file)?.[CALDAV_FRONTMATTER_KEYS.account]) === account.id;

			// A task already linked to this account stays in scope even if it no
			// longer matches the scope, so it can be unlinked deliberately rather
			// than silently stranded on the server.
			if (!ownedByAccount && !taskBelongsToCollection(task, scope)) continue;

			snapshots.push(this.snapshotTask(task, file));
		}

		return snapshots;
	}

	private snapshotTask(task: TaskInfo, file: TFile): LocalTaskSnapshot {
		const frontmatter = this.readFrontmatter(file);
		return {
			path: task.path,
			uid: asString(frontmatter?.[CALDAV_FRONTMATTER_KEYS.uid]),
			href: asString(frontmatter?.[CALDAV_FRONTMATTER_KEYS.href]),
			etag: asString(frontmatter?.[CALDAV_FRONTMATTER_KEYS.etag]),
			changedAtMs: localChangedAtMs(task, file),
			syncedFingerprint: this.state.fingerprints[task.path],
			fingerprint: getCalDavRelevantFingerprint(task),
		};
	}

	private resolveAccountForTask(task: TaskInfo): CalDavAccountSettings | undefined {
		const owner = asString(this.readFrontmatterAt(task.path)?.[CALDAV_FRONTMATTER_KEYS.account]);
		if (owner) {
			const account = this.getAccount(owner);
			if (account?.enabled) return account;
		}
		return this.enabledAccounts().find((account) =>
			taskBelongsToCollection(task, scopeFor(account))
		);
	}

	private mappingContext(account: CalDavAccountSettings): VTodoMappingContext {
		return {
			statuses: this.api.catalog.statuses(),
			priorities: this.api.catalog.priorities(),
			statusOverrides: account.statusOverrides,
		};
	}

	// -----------------------------------------------------------------------
	// Frontmatter (only our own caldav_* keys are ever written directly)
	// -----------------------------------------------------------------------

	private async stampSyncMetadata(
		path: string,
		metadata: { uid: string; href: string; etag?: string; accountId: string }
	): Promise<void> {
		const file = this.requireFile(path);

		await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter[CALDAV_FRONTMATTER_KEYS.uid] = metadata.uid;
			frontmatter[CALDAV_FRONTMATTER_KEYS.href] = metadata.href;
			frontmatter[CALDAV_FRONTMATTER_KEYS.account] = metadata.accountId;
			frontmatter[CALDAV_FRONTMATTER_KEYS.syncedAt] = new Date().toISOString();
			if (metadata.etag) {
				frontmatter[CALDAV_FRONTMATTER_KEYS.etag] = metadata.etag;
			} else {
				delete frontmatter[CALDAV_FRONTMATTER_KEYS.etag];
			}
		});

		// Record the fingerprint straight after, so the task.updated event this
		// write triggers is recognised as a no-op.
		const task = await this.api.tasks.get(path);
		if (task) await this.recordFingerprint(path, getCalDavRelevantFingerprint(task));
	}

	private async clearSyncMetadata(path: string): Promise<void> {
		const file = this.requireFile(path);

		await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
			for (const key of Object.values(CALDAV_FRONTMATTER_KEYS)) {
				delete frontmatter[key];
			}
		});
	}

	private readFrontmatter(file: TFile): Record<string, unknown> | undefined {
		return this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	private readFrontmatterAt(path: string): Record<string, unknown> | undefined {
		const file = this.getFile(path);
		return file ? this.readFrontmatter(file) : undefined;
	}

	private getFile(path: string): TFile | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/** For writes that must land: a missing note here means the sync lost track of it. */
	private requireFile(path: string): TFile {
		const file = this.getFile(path);
		if (!file) throw new Error(`No note at ${path} to write CalDAV metadata to`);
		return file;
	}

	// -----------------------------------------------------------------------
	// Persisted state
	// -----------------------------------------------------------------------

	private async recordFingerprint(path: string, fingerprint: string): Promise<void> {
		if (this.state.fingerprints[path] === fingerprint) return;
		this.state.fingerprints[path] = fingerprint;
		await this.plugin.saveState();
	}

	private async forgetTask(path: string): Promise<void> {
		delete this.state.fingerprints[path];
		this.state.resourceIndex = this.state.resourceIndex.filter((entry) => entry.path !== path);
		await this.plugin.saveState();
	}

	private async indexResource(entry: CalDavResourceIndexEntry): Promise<void> {
		this.state.resourceIndex = this.state.resourceIndex.filter(
			(existing) =>
				!(existing.accountId === entry.accountId && existing.uid === entry.uid) &&
				existing.path !== entry.path
		);
		this.state.resourceIndex.push(entry);
		await this.plugin.saveState();
	}

	private async findPathForUid(accountId: string, uid: string): Promise<string | undefined> {
		const entry = this.state.resourceIndex.find(
			(candidate) => candidate.accountId === accountId && candidate.uid === uid
		);
		if (entry && this.getFile(entry.path)) return entry.path;

		// The index can go stale when a task is renamed while this plugin is off;
		// fall back to a scan rather than creating a duplicate.
		for (const task of await this.api.tasks.list()) {
			if (this.uidForPath(task.path) === uid) return task.path;
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// Timers and plumbing
	// -----------------------------------------------------------------------

	private startPollTimer(accountId: string): void {
		const account = this.getAccount(accountId);
		if (!account?.enabled || this.destroyed) return;

		const intervalMs = Math.max(1, account.syncIntervalMinutes) * 60 * 1000;
		const timer = window.setTimeout(() => {
			void this.syncAccount(accountId).finally(() => {
				if (!this.destroyed) this.startPollTimer(accountId);
			});
		}, intervalMs);

		this.pollTimers.set(accountId, timer);
	}

	private createClient(account: CalDavAccountSettings): CalDavClient {
		const credentials = this.secretStore.getCredentials(account.id);
		if (!credentials) {
			throw new CalDavError(
				"auth",
				`No stored credentials for CalDAV account ${account.name || account.id}`
			);
		}
		return new CalDavClient({
			serverUrl: account.serverUrl || account.collectionUrl,
			credentials,
			logger: createLogger("CalDavClient"),
		});
	}

	private reportSyncError(account: CalDavAccountSettings, error: unknown): void {
		if (error instanceof CalDavError && error.kind === "auth") {
			this.plugin.notify(
				`Could not sign in to the CalDAV account "${account.name || account.id}". Check its username and password.`
			);
		}
		this.logError("CalDAV sync failed", error, {
			operation: "sync-account",
			accountId: account.id,
		});
	}

	private logError(
		message: string,
		error: unknown,
		context: { operation: string; [key: string]: unknown }
	): void {
		this.logger.error(message, { operation: context.operation, details: context, error });
	}
}

interface RemoteSnapshotWithData extends RemoteTodoSnapshot {
	data: string;
}

function toRemoteSnapshot(
	url: string,
	etag: string | undefined,
	data: string | undefined
): RemoteSnapshotWithData | null {
	if (!data) return null;
	const doc = parseVTodoDocument(data);
	if (!doc) return null;
	const uid = readVTodoUid(doc);
	if (!uid) return null;
	return { uid, url, etag, revisionMs: readVTodoRevision(doc), data };
}

function scopeFor(account: CalDavAccountSettings): CalDavCollectionScope {
	return { accountId: account.id, tag: account.scopeTag, folder: account.scopeFolder };
}

/**
 * `dateModified` is optional and user-renameable, so the file's mtime is the
 * fallback for deciding which side of a conflict is newer.
 */
function localChangedAtMs(task: TaskInfo, file: TFile): number | null {
	if (task.dateModified) {
		const parsed = Date.parse(task.dateModified);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return file.stat?.mtime ?? null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A short, loggable description of a failure.
 *
 * Deliberately the message only: CalDAV errors can carry request context, and
 * none of it belongs in a file that syncs around with the vault.
 */
function describeError(error: unknown): string {
	if (error instanceof CalDavError) return `${error.kind}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return "Unknown error";
}

function joinUrl(base: string, segment: string): string {
	return `${base.replace(/\/+$/u, "")}/${segment}`;
}

/**
 * UIDs must be globally unique and stable for the life of the task. A random
 * UUID avoids leaking the vault path to everyone the collection is shared with.
 */
function generateUid(): string {
	return `${window.crypto.randomUUID()}@tasknotes`;
}
