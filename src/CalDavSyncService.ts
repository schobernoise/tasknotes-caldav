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

import { Notice, TFile } from "obsidian";

import type CalDavPlugin from "./main";
import type { CalDavAccountSettings, CalDavTaskList } from "./settings";
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
import { retagForList, routeTask, type AccountRouting, type TaskListRoute } from "./caldav/collectionMembership";
import {
	applyTaskToVTodo,
	changedFields,
	mergeRemoteTags,
	readVTodoIntoTaskPatch,
	readVTodoRevision,
	readVTodoUid,
	type VTodoMappingContext,
	type VTodoTaskPatch,
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

/** One task (or a whole account, for connection errors) that a sync run could not handle. */
export interface SyncFailure {
	path: string;
	message: string;
}

/** Shows a sticky notice summarising failures; the full list is in the developer console. */
export function noticeFailures(failures: readonly SyncFailure[]): void {
	const [first] = failures;
	const more = failures.length > 1 ? ` See the developer console for all ${failures.length}.` : "";
	new Notice(`CalDAV: ${failures.length} task(s) could not be synced. ${first.path}: ${first.message}.${more}`, 0);
}

interface CalDavResourceIndexEntry {
	uid: string;
	path: string;
	href: string;
}

/** A task list and the account whose login reaches it. */
interface SyncTarget {
	account: CalDavAccountSettings;
	list: CalDavTaskList;
}

/** A list's first-sync plan, plus the linked tasks whose tags will move them into it. */
export interface ListFirstSyncPreview {
	list: CalDavTaskList;
	plan: FirstSyncPlan;
	moveIn: string[];
}

/** Sync bookkeeping persisted next to the settings in this plugin's data.json. */
export interface SyncState {
	fingerprints: Record<string, string>;
	/** Keyed by list id. */
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
	private relationFlushTimer: number | null = null;
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
		if (this.relationFlushTimer !== null) window.clearTimeout(this.relationFlushTimer);
		this.relationFlushTimer = null;
		this.pollTimers.clear();
		this.pushTimers.clear();
	}

	private enabledAccounts(): CalDavAccountSettings[] {
		return this.settings.accounts.filter((account) => account.enabled && account.lists.length > 0);
	}

	private getAccount(accountId: string): CalDavAccountSettings | undefined {
		return this.settings.accounts.find((account) => account.id === accountId);
	}

	private findTarget(listId: string | undefined): SyncTarget | undefined {
		for (const account of this.settings.accounts) {
			const list = account.lists.find((candidate) => candidate.id === listId);
			if (list) return { account, list };
		}
		return undefined;
	}

	/**
	 * Where a task should sync to now: its own account is asked first, so a
	 * linked task stays put while its list still claims it.
	 *
	 * A list still waiting for its first sync takes unlinked tasks (they upload
	 * during that first sync) but does not pull linked ones away from a working
	 * list until then; `activating` names the list whose first sync is running.
	 */
	private routeTarget(task: TaskInfo, activating?: string): SyncTarget | undefined {
		const linkedId = this.listIdAt(task.path);
		const current = this.findTarget(linkedId);
		if (current && !current.account.enabled && current.list.id !== activating) return undefined;

		const others = this.settings.accounts.filter(
			(account) =>
				account !== current?.account &&
				account.lists.length > 0 &&
				(account.enabled || account.lists.some((list) => list.id === activating))
		);
		const accounts = current ? [current.account, ...others] : others;

		for (const account of accounts) {
			const listId = routeTask(task, routingFor(account), account === current?.account ? linkedId : undefined);
			const list = account.lists.find((candidate) => candidate.id === listId);
			if (!list) continue;
			if (current && !list.initialSyncCompleted && list.id !== activating) return current;
			return { account, list };
		}
		return current;
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

		if (!this.routeTarget(task) || !this.settings.pushOnChange) {
			// Out of scope, or waiting for the poll: remember the fingerprint so
			// we do not re-evaluate it on every keystroke.
			await this.recordFingerprint(path, fingerprint);
			return;
		}

		this.schedulePush(path);
	}

	/** Deletes the remote VTODO when its task file is removed from the vault. */
	async handleTaskFileDeleted(
		path: string,
		previousFrontmatter?: Record<string, unknown>
	): Promise<void> {
		if (this.destroyed) return;

		const target = this.findTarget(asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.account]));
		const href = asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.href]);
		const etag = asString(previousFrontmatter?.[CALDAV_FRONTMATTER_KEYS.etag]);
		if (!target?.account.enabled || !href) return;

		try {
			const client = this.createClient(target.account);
			await client.deleteResource(href, etag ? { ifMatch: etag } : {});
			await this.forgetTask(path);
		} catch (error) {
			this.logError("Failed to delete remote task", error, { operation: "delete-remote" });
		}
	}

	private schedulePush(path: string): void {
		const existing = this.pushTimers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.pushTimers.delete(path);
			void this.pushIfStillChanged(path).catch((error: unknown) => {
				this.logError("Failed to push task", error, { operation: "push" });
				// Without this the edit is simply lost until the task is touched
				// again: a transient network failure would silently desync a task.
				void this.enqueueRetry(path, error);
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
	private async pushIfStillChanged(path: string): Promise<void> {
		const task = await this.api.tasks.get(path);
		if (task && this.state.fingerprints[path] === getCalDavRelevantFingerprint(task)) return;
		await this.pushTask(path);
	}

	/** Pushes a task to the list its tags route it to, moving it there if it lives elsewhere. */
	async pushTask(path: string): Promise<void> {
		if (this.destroyed) return;
		const task = await this.api.tasks.get(path);
		const target = task ? this.routeTarget(task) : undefined;
		// A list waiting for its first sync uploads its tasks during that sync.
		if (!task || !target?.list.initialSyncCompleted) return;
		await this.putTask(target, task);
	}

	private async putTask(target: SyncTarget, task: TaskInfo): Promise<void> {
		const { path } = task;
		const file = this.getFile(path);
		if (!file) return;

		const snapshot = this.snapshotTask(task, file);
		const uid = snapshot.uid ?? generateUid();
		const linked = this.findTarget(this.listIdAt(path));
		let existingData: string | undefined;
		let etag = snapshot.etag;
		let href = snapshot.href;

		if (href && linked && linked.list.id !== target.list.id) {
			const moved = await this.detachForMove(linked, target, task, href, snapshot.etag);
			if (moved === null) return;
			existingData = moved;
			href = etag = undefined;
		} else if (href && !linked) {
			// Linked to a list that no longer exists here: upload afresh.
			href = etag = undefined;
		} else if (href) {
			// Fetch the current resource first so properties we do not model —
			// VALARM, X- properties, DESCRIPTION written on a phone — survive.
			existingData = (await this.createClient(target.account).getResource(href))?.data;
		}
		href ??= joinUrl(target.list.url, `${uid}.ics`);

		const doc = (existingData ? parseVTodoDocument(existingData) : null) ?? createVTodoDocument();
		applyTaskToVTodo(doc, task, this.mappingContext(target), { uid });
		const relations = await this.resolveOutboundRelations(task);
		applyRelations(doc, relations.relations);
		applyReminders(doc, task.reminders ?? []);
		const body = serializeVTodoDocument(doc);

		const result = await this.createClient(target.account).putResource(
			href,
			body,
			etag ? { ifMatch: etag } : { ifNoneMatch: "*" }
		);

		if (result.conflict) {
			await this.resolveConflictAt(target, path, href, task);
			return;
		}

		await this.stampSyncMetadata(path, { uid, href, etag: result.etag, listId: target.list.id });
		await this.indexResource({ uid, path, href });

		// A parent pushed moments earlier only gets its UID once its own write
		// lands, so revisit the link rather than leaving the hierarchy missing
		// on the server until the next poll.
		if (relations.unresolved && !this.flushingRelations) {
			this.pendingRelationPaths.add(path);
			this.scheduleRelationFlush();
		}
	}

	/**
	 * First half of moving a task to another list: removes it from the old one
	 * and relinks the note to the new one without an href, so a failed upload
	 * afterwards is retried as a plain upload rather than lost.
	 *
	 * Resolves with the old body, so what the plugin does not model carries
	 * over, or null when the move cannot happen now (the old copy changed or
	 * vanished, which the usual conflict or deletion handling takes over).
	 */
	private async detachForMove(
		from: SyncTarget,
		to: SyncTarget,
		task: TaskInfo,
		href: string,
		etag: string | undefined
	): Promise<string | null> {
		const client = this.createClient(from.account);
		const current = await client.getResource(href);
		if (!current?.data) {
			await this.applyRemoteDeletion(from, task.path);
			return null;
		}
		const removed = await client.deleteResource(href, etag ? { ifMatch: etag } : {});
		if (removed.conflict) {
			await this.resolveConflictAt(from, task.path, href, task);
			return null;
		}

		this.handlingPaths.add(task.path);
		try {
			await this.plugin.app.fileManager.processFrontMatter(this.requireFile(task.path), (frontmatter) => {
				frontmatter[CALDAV_FRONTMATTER_KEYS.account] = to.list.id;
				delete frontmatter[CALDAV_FRONTMATTER_KEYS.href];
				delete frontmatter[CALDAV_FRONTMATTER_KEYS.etag];
			});
		} finally {
			this.handlingPaths.delete(task.path);
		}
		this.logger.info("Moving task to another list", {
			operation: "move",
			details: { path: task.path, from: from.list.id, to: to.list.id },
		});
		return current.data;
	}

	/**
	 * Runs after a 412. The ETag mismatch has already established that both
	 * sides changed; this only decides who wins and applies it.
	 */
	private async resolveConflictAt(
		target: SyncTarget,
		path: string,
		href: string,
		task: TaskInfo
	): Promise<void> {
		const client = this.createClient(target.account);
		const current = await client.getResource(href);

		if (!current?.data) {
			// Vanished between the PUT and the GET: treat as a remote deletion.
			await this.applyRemoteDeletion(target, path);
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
			applyTaskToVTodo(remoteDoc, task, this.mappingContext(target), {
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
					listId: target.list.id,
				});
			}
			return;
		}

		await this.applyRemotePatch(target, path, {
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

	/**
	 * One polling pass over every list of an account. Resolves with what
	 * failed, already logged; a task that fails is skipped so it cannot block
	 * the rest.
	 *
	 * All lists are read together because a task moved between lists on a
	 * phone vanishes from one and appears in another: seen one list at a time,
	 * that is a deletion plus a new task.
	 */
	async syncAccount(accountId: string, options: { force?: boolean } = {}): Promise<SyncFailure[]> {
		const force = options.force ?? false;
		const account = this.getAccount(accountId);
		if (!account?.enabled || this.destroyed) return [];
		if (this.inFlightAccounts.has(accountId)) return [];
		const failures: SyncFailure[] = [];

		this.inFlightAccounts.add(accountId);
		try {
			const client = this.createClient(account);
			const active = account.lists.filter((list) => list.initialSyncCompleted);

			// Collections routinely mix VTODOs with far more VEVENTs, so ask for
			// the change tokens first and skip everything else when none moved.
			// Walking the resource lists instead would drag down every event body
			// just to discover none of them are tasks.
			const tags = new Map<string, { ctag?: string; syncToken?: string }>();
			for (const list of active) tags.set(list.id, await client.getCollectionTag(list.url));
			const unchanged = active.every((list) => {
				const tag = tags.get(list.id);
				const currentTag = tag?.ctag ?? tag?.syncToken;
				return currentTag !== undefined && this.state.collectionState[list.id]?.ctag === currentTag;
			});
			if (unchanged && !force) return [];

			// A VTODO-filtered calendar-query returns only tasks, and returns all
			// of them — completeness is what makes deletion detection safe.
			const remotesByList = new Map<string, RemoteSnapshotWithData[]>();
			for (const list of account.lists) {
				remotesByList.set(list.id, await this.fetchRemoteSnapshots(client, list));
			}
			const moved = await this.adoptRemoteMoves(account, remotesByList, failures);

			for (const list of active) {
				const listFailures = await this.syncList(
					{ account, list },
					(remotesByList.get(list.id) ?? []).filter((remote) => !moved.uids.has(remote.uid)),
					moved.paths
				);
				failures.push(...listFailures);

				// Only a clean run moves the bookmark; otherwise the next poll would
				// see an unchanged list and never retry what failed.
				if (listFailures.length === 0) {
					const tag = tags.get(list.id);
					this.state.collectionState[list.id] = {
						syncToken: tag?.syncToken ?? this.state.collectionState[list.id]?.syncToken,
						ctag: tag?.ctag ?? tag?.syncToken,
						lastSyncedAt: new Date().toISOString(),
					};
				}
			}
			await this.plugin.saveState();
			return failures;
		} catch (error) {
			this.reportSyncError(account, error);
			return [...failures, { path: account.name || account.id, message: describeError(error) }];
		} finally {
			this.inFlightAccounts.delete(accountId);
		}
	}

	/**
	 * Relinks tasks whose VTODO now sits in a different list of the account, as
	 * after a move on a phone, and swaps their routing tags to match.
	 *
	 * Resolves with what it handled, so the per-list passes skip it: Obsidian's
	 * metadata cache still shows the old link until it catches up with the
	 * write, and the old list would read that as a deletion.
	 */
	private async adoptRemoteMoves(
		account: CalDavAccountSettings,
		remotesByList: ReadonlyMap<string, readonly RemoteSnapshotWithData[]>,
		failures: SyncFailure[]
	): Promise<{ paths: Set<string>; uids: Set<string> }> {
		const moved = { paths: new Set<string>(), uids: new Set<string>() };
		const listOfUid = new Map<string, { list: CalDavTaskList; remote: RemoteSnapshotWithData }>();
		for (const list of account.lists) {
			for (const remote of remotesByList.get(list.id) ?? []) listOfUid.set(remote.uid, { list, remote });
		}

		for (const task of await this.api.tasks.list()) {
			const from = account.lists.find((list) => list.id === this.listIdAt(task.path));
			const uid = this.uidForPath(task.path);
			const found = uid ? listOfUid.get(uid) : undefined;
			if (!from || !uid || !found || found.list === from) continue;
			if ((remotesByList.get(from.id) ?? []).some((remote) => remote.uid === uid)) continue;

			await this.isolate(failures, task.path, () =>
				this.applyRemotePatch({ account, list: found.list }, task.path, found.remote, from)
			);
			moved.paths.add(task.path);
			moved.uids.add(uid);
		}
		return moved;
	}

	/** One list's share of a poll: pull, resolve, delete and push as planned. */
	private async syncList(
		target: SyncTarget,
		remotes: readonly RemoteSnapshotWithData[],
		skipPaths: ReadonlySet<string>
	): Promise<SyncFailure[]> {
		const failures: SyncFailure[] = [];
		const locals = (await this.snapshotListTasks(target)).filter((local) => !skipPaths.has(local.path));
		const plan = planIncrementalSync(locals, remotes, { remotesAreComplete: true });

		// Linked here but now routed elsewhere, e.g. after its list's tags were
		// edited in settings: pushing moves it.
		const planned = new Set(
			[...plan.toPush, ...plan.remoteDeleted, ...plan.conflicts.map((conflict) => conflict.local)].map(
				(local) => local.path
			)
		);
		for (const local of locals) {
			if (!local.uid || planned.has(local.path)) continue;
			const task = await this.api.tasks.get(local.path);
			const routed = task ? this.routeTarget(task) : undefined;
			if (routed && routed.list.id !== target.list.id) plan.toPush.push(local);
		}

		for (const remote of plan.toPull) {
			const withData = remotes.find((entry) => entry.uid === remote.uid);
			if (withData) {
				await this.isolate(failures, `server task ${remote.uid}`, () =>
					this.applyRemotePatch(target, undefined, withData)
				);
			}
		}

		for (const conflict of plan.conflicts) {
			await this.isolate(failures, conflict.local.path, async () => {
				if (conflict.winner === "local") {
					await this.pushTask(conflict.local.path);
					return;
				}
				const withData = remotes.find((entry) => entry.uid === conflict.remote.uid);
				if (withData) await this.applyRemotePatch(target, conflict.local.path, withData);
			});
		}

		for (const local of plan.remoteDeleted) {
			await this.isolate(failures, local.path, () => this.applyRemoteDeletion(target, local.path));
		}

		for (const local of plan.toPush) {
			await this.isolate(failures, local.path, () => this.pushTask(local.path));
		}

		await this.flushRelations();
		return failures;
	}

	/**
	 * Writes a remote VTODO into the vault, either patching the matching task or
	 * creating one. `knownPath` short-circuits the index lookup when the caller
	 * already knows which task this is; `movedFrom` is the list the task was in
	 * before it was moved on the server, whose routing tags it sheds.
	 */
	private async applyRemotePatch(
		target: SyncTarget,
		knownPath: string | undefined,
		remote: RemoteSnapshotWithData,
		movedFrom?: CalDavTaskList
	): Promise<void> {
		const doc = parseVTodoDocument(remote.data);
		if (!doc) return;

		const uid = readVTodoUid(doc) ?? remote.uid;
		const context = this.mappingContext(target);
		const patch = readVTodoIntoTaskPatch(doc, context);
		const path = knownPath ?? (await this.findPathForUid(uid));

		if (path) {
			const local = await this.api.tasks.get(path);
			if (!local) return;
			const ownEncoding = createVTodoDocument();
			applyTaskToVTodo(ownEncoding, local, context, { uid });
			const updates = toTaskUpdate(
				changedFields(patch, readVTodoIntoTaskPatch(ownEncoding, context)),
				local,
				this.protectedTags(target.list)
			);
			if (movedFrom) {
				updates.tags = retagForList(updates.tags ?? local.tags ?? [], routeOf(movedFrom), routeOf(target.list));
			}
			// A title change renames the note when TaskNotes stores titles in
			// filenames, so everything after the update follows the returned path.
			let currentPath = path;
			this.handlingPaths.add(path);
			try {
				const updated =
					Object.keys(updates).length > 0
						? await this.api.tasks.update(path, updates, CONTEXT)
						: local;
				currentPath = updated.path;
				this.handlingPaths.add(currentPath);
				await this.stampSyncMetadata(currentPath, {
					uid,
					href: remote.url,
					etag: remote.etag,
					listId: target.list.id,
				});
				if (currentPath !== path) await this.forgetTask(path);
			} finally {
				this.handlingPaths.delete(path);
				this.handlingPaths.delete(currentPath);
			}
			await this.indexResource({ uid, path: currentPath, href: remote.url });
			await this.applyInboundRelations(currentPath, doc);
			return;
		}

		// New on the server: create through TaskNotes so folder rules, templates
		// and defaults all apply. It takes its list's tag, so routing keeps it there.
		const tags = retagForList(
			mergeRemoteTags(patch.tags ?? [], this.taskTags(), this.taskTags()),
			undefined,
			routeOf(target.list)
		);
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
				...(tags.length ? { tags } : {}),
				creationContext: "import",
				// The CalDAV keys are not TaskNotes fields, so they travel as
				// custom frontmatter and land in the file in the same write.
				customFrontmatter: {
					[CALDAV_FRONTMATTER_KEYS.uid]: uid,
					[CALDAV_FRONTMATTER_KEYS.href]: remote.url,
					...(remote.etag ? { [CALDAV_FRONTMATTER_KEYS.etag]: remote.etag } : {}),
					[CALDAV_FRONTMATTER_KEYS.account]: target.list.id,
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
		await this.indexResource({ uid, path: created.path, href: remote.url });
		// Deferred: a parent imported later in this same run has no path yet.
		this.pendingInboundRelations.push({ path: created.path, doc });
	}

	/**
	 * Syncs every enabled account now, ignoring the change gate.
	 *
	 * Forced because the point of asking is usually to check a suspicion that
	 * the tokens are lying.
	 */
	async syncAllAccounts(): Promise<{ accounts: number; failures: SyncFailure[] }> {
		const accounts = this.enabledAccounts();
		const failures: SyncFailure[] = [];
		for (const account of accounts) {
			failures.push(...(await this.syncAccount(account.id, { force: true })));
		}
		return { accounts: accounts.length, failures };
	}

	/** Runs one task's step; a failure is recorded and logged, and the run carries on. */
	private async isolate(
		failures: SyncFailure[],
		path: string,
		step: () => Promise<void>
	): Promise<void> {
		try {
			await step();
		} catch (error) {
			failures.push({ path, message: describeError(error) });
			this.logError("CalDAV sync failed for a task", error, { operation: "sync-task", path });
		}
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
				await this.unlinkTask(path);
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

	/** Removes a task's CalDAV link, leaving the note and the server copy alone. */
	private async unlinkTask(path: string): Promise<void> {
		await this.clearSyncMetadata(path);

		// Keep the fingerprint rather than forgetting it. Dropping it would make
		// the task look freshly edited, and push-on-change would immediately
		// re-upload it under a new UID — unlinking would undo itself and leave a
		// duplicate behind.
		const task = await this.api.tasks.get(path);
		if (task) await this.recordFingerprint(path, getCalDavRelevantFingerprint(task));
	}

	/**
	 * Takes a list out of an account's routing. Its tasks move to wherever
	 * their tags now route them; a task with nowhere to go is unlinked and its
	 * copy stays on the server. The list is only dropped from the settings when
	 * every task left it, so a failed move can be retried.
	 */
	async removeList(accountId: string, listId: string): Promise<SyncFailure[]> {
		const account = this.getAccount(accountId);
		const list = account?.lists.find((candidate) => candidate.id === listId);
		if (!account || !list) return [];
		const remaining = account.lists.filter((candidate) => candidate !== list);
		const routing = routingFor({
			...account,
			lists: remaining,
			defaultListId: account.defaultListId === listId ? "" : account.defaultListId,
		});
		const failures: SyncFailure[] = [];

		for (const task of await this.api.tasks.list()) {
			if (this.listIdAt(task.path) !== listId) continue;
			const destination = remaining.find((candidate) => candidate.id === routeTask(task, routing, listId));
			await this.isolate(failures, task.path, () =>
				destination ? this.putTask({ account, list: destination }, task) : this.unlinkTask(task.path)
			);
		}

		if (failures.length === 0) {
			account.lists = remaining;
			if (account.defaultListId === listId) account.defaultListId = "";
			delete this.state.collectionState[listId];
			await this.plugin.saveSettings();
		}
		return failures;
	}

	// -----------------------------------------------------------------------
	// Retry queue
	// -----------------------------------------------------------------------

	private async enqueueRetry(path: string, error: unknown): Promise<void> {
		const existing = this.state.syncQueue.find((entry) => entry.taskPath === path);
		if (existing) {
			existing.lastError = describeError(error);
		} else {
			this.state.syncQueue.push({
				taskPath: path,
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
			const linked = this.findTarget(this.listIdAt(entry.taskPath));
			if (linked && !linked.account.enabled) {
				// Hold rather than drop: the account may simply be switched off
				// for now, and the edit is still worth sending when it returns.
				remaining.push(entry);
				continue;
			}

			try {
				await this.pushTask(entry.taskPath);
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
			(entry) => !queue.some((seen) => seen.taskPath === entry.taskPath)
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
			// Expected whenever a parent is archived or not synced at all —
			// not a failure, so not a warning.
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
	private async applyInboundRelations(path: string, doc: VTodoDocument): Promise<void> {
		const { parents, dependencies } = readRelations(doc);
		const reminders = readReminders(doc);

		const projects: string[] = [];
		for (const uid of parents) {
			const parentPath = await this.findPathForUid(uid);
			const file = parentPath ? this.getFile(parentPath) : null;
			if (file) projects.push(this.wikilink(file, path));
		}

		const blockedBy: TaskDependency[] = [];
		for (const dependency of dependencies) {
			const targetPath = await this.findPathForUid(dependency.uid);
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
	private async flushInboundRelations(): Promise<void> {
		const pending = this.pendingInboundRelations;
		this.pendingInboundRelations = [];

		for (const entry of pending) {
			try {
				await this.applyInboundRelations(entry.path, entry.doc);
			} catch (error) {
				this.logError("Failed to apply imported relations", error, {
					operation: "caldav-flush-inbound-relations",
					path: entry.path,
				});
			}
		}
	}

	private async flushRelations(): Promise<void> {
		await this.flushInboundRelations();
		await this.flushPendingRelations();
	}

	/**
	 * Queues the deferred relation pass shortly after a push.
	 *
	 * Without this a new subtask shows no parent on the server until the next
	 * poll, which can be a quarter of an hour away.
	 */
	private scheduleRelationFlush(): void {
		if (this.destroyed || this.relationFlushTimer !== null) return;

		this.relationFlushTimer = window.setTimeout(() => {
			this.relationFlushTimer = null;
			void this.flushPendingRelations().catch((error: unknown) => {
				this.logError("Failed to replay deferred relations", error, {
					operation: "caldav-flush-relations",
				});
			});
		}, this.settings.pushDebounceMs * 2);
	}

	/** Re-pushes tasks whose relations could not be addressed on the first pass. */
	private async flushPendingRelations(): Promise<void> {
		const paths = [...this.pendingRelationPaths];
		this.pendingRelationPaths.clear();
		if (paths.length === 0) return;

		// Exactly one extra pass: a parent that is still unaddressable is archived
		// or not synced, and retrying would never change that.
		this.flushingRelations = true;
		try {
			for (const path of paths) {
				try {
					await this.pushTask(path);
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
	private async applyRemoteDeletion(target: SyncTarget, path: string): Promise<void> {
		const outcome = planRemoteDeletion(target.account.remoteDeletionPolicy);
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

	/**
	 * Computes the first-sync plan of every list of the account still waiting
	 * for one, without writing anything — the dry run.
	 */
	async previewFirstSync(accountId: string): Promise<ListFirstSyncPreview[]> {
		const account = this.getAccount(accountId);
		if (!account) throw new Error(`Unknown CalDAV account ${accountId}`);
		const pending = account.lists.filter((list) => !list.initialSyncCompleted);
		for (const list of pending) {
			// Imports into it would carry no tag, and the next poll would route
			// them off to the default list.
			if (list.tags.length === 0 && list.id !== account.defaultListId) {
				throw new Error(`"${list.name || list.url}" has no tags and is not the default list. Give it a tag first`);
			}
		}

		const client = this.createClient(account);
		const tasks = await this.api.tasks.list();
		const previews: ListFirstSyncPreview[] = [];
		for (const list of pending) {
			const target = { account, list };
			const remotes = await this.fetchRemoteSnapshots(client, list);
			const locals = await this.snapshotListTasks(target, list.id);
			const moveIn = tasks
				.filter((task) => {
					const linked = this.listIdAt(task.path);
					return linked !== undefined && linked !== list.id && this.routeTarget(task, list.id)?.list === list;
				})
				.map((task) => task.path);
			previews.push({ list, plan: planFirstSync(locals, remotes), moveIn });
		}
		return previews;
	}

	/**
	 * Applies previews the user has confirmed and marks each list live.
	 * Resolves with the tasks that failed, already logged.
	 */
	async applyFirstSync(accountId: string, previews: readonly ListFirstSyncPreview[]): Promise<SyncFailure[]> {
		const account = this.getAccount(accountId);
		if (!account) return [];
		const failures: SyncFailure[] = [];

		for (const { list, plan, moveIn } of previews) {
			const target = { account, list };
			list.initialSyncCompleted = true;
			await this.plugin.saveSettings();

			for (const local of [...plan.toUpload.map((entry) => entry.path), ...moveIn]) {
				await this.isolate(failures, local, async () => {
					const task = await this.api.tasks.get(local);
					if (task) await this.putTask(target, task);
				});
			}

			for (const remote of plan.toImport) {
				const withData = remote as RemoteSnapshotWithData;
				if (withData.data) {
					await this.isolate(failures, `server task ${remote.uid}`, () =>
						this.applyRemotePatch(target, undefined, withData)
					);
				}
			}

			for (const pair of plan.toLink) {
				await this.isolate(failures, pair.local.path, async () => {
					await this.stampSyncMetadata(pair.local.path, {
						uid: pair.remote.uid,
						href: pair.remote.url,
						etag: pair.remote.etag,
						listId: list.id,
					});
					await this.indexResource({ uid: pair.remote.uid, path: pair.local.path, href: pair.remote.url });
				});
			}

			for (const pair of plan.toResolve) {
				await this.isolate(failures, pair.local.path, async () => {
					if (pair.winner === "local") {
						const task = await this.api.tasks.get(pair.local.path);
						if (task) await this.putTask(target, task);
						return;
					}
					const withData = pair.remote as RemoteSnapshotWithData;
					if (withData.data) await this.applyRemotePatch(target, pair.local.path, withData);
				});
			}

			this.logger.info("Completed first CalDAV sync", {
				operation: "first-sync",
				details: { listId: list.id, ...summarizeFirstSyncPlan(plan), moveIn: moveIn.length },
			});
		}

		// Only now does every task on both sides have both a path and a UID, so
		// this is the first point at which relations can be written at all.
		await this.flushRelations();
		return failures;
	}

	// -----------------------------------------------------------------------
	// Snapshots and routing
	// -----------------------------------------------------------------------

	private async fetchRemoteSnapshots(
		client: CalDavClient,
		list: CalDavTaskList
	): Promise<RemoteSnapshotWithData[]> {
		return (await client.fetchAllVTodos(list.url))
			.map((resource) => toRemoteSnapshot(resource.url, resource.etag, resource.data))
			.filter((snapshot): snapshot is RemoteSnapshotWithData => snapshot !== null);
	}

	/**
	 * The tasks linked to a list, plus unlinked ones routed to it. A task
	 * linked here stays in the snapshot even when it no longer routes here, so
	 * the pass that sees it can move it rather than strand it on the server.
	 */
	private async snapshotListTasks(target: SyncTarget, activating?: string): Promise<LocalTaskSnapshot[]> {
		const snapshots: LocalTaskSnapshot[] = [];

		for (const task of await this.api.tasks.list()) {
			const file = this.getFile(task.path);
			if (!file) continue;

			const linkedId = this.listIdAt(task.path);
			const belongs =
				linkedId === target.list.id ||
				(!this.findTarget(linkedId) && this.routeTarget(task, activating)?.list === target.list);
			if (belongs) snapshots.push(this.snapshotTask(task, file));
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

	private mappingContext(target: SyncTarget): VTodoMappingContext {
		return {
			statuses: this.api.catalog.statuses(),
			priorities: this.api.catalog.priorities(),
			statusOverrides: target.account.statusOverrides,
			// The list already says what its routing tags would.
			hiddenTags: [...(this.settings.syncTaskTag ? [] : this.taskTags()), ...target.list.tags],
		};
	}

	/** Tags a phone app cannot remove from a note, because the server never shows them. */
	private protectedTags(list: CalDavTaskList): string[] {
		return [...this.taskTags(), ...list.tags];
	}

	/** The tag TaskNotes recognises task notes by, when it identifies them by tag. */
	taskTags(): string[] {
		const { taskIdentificationMethod, taskTag } = this.api.settings.snapshot();
		return taskIdentificationMethod === "tag" && taskTag ? [taskTag] : [];
	}

	// -----------------------------------------------------------------------
	// Frontmatter (only our own caldav_* keys are ever written directly)
	// -----------------------------------------------------------------------

	private async stampSyncMetadata(
		path: string,
		metadata: { uid: string; href: string; etag?: string; listId: string }
	): Promise<void> {
		const file = this.requireFile(path);

		await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter[CALDAV_FRONTMATTER_KEYS.uid] = metadata.uid;
			frontmatter[CALDAV_FRONTMATTER_KEYS.href] = metadata.href;
			frontmatter[CALDAV_FRONTMATTER_KEYS.account] = metadata.listId;
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

	/** The list a note is linked to. */
	private listIdAt(path: string): string | undefined {
		return asString(this.readFrontmatterAt(path)?.[CALDAV_FRONTMATTER_KEYS.account]);
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
			(existing) => existing.uid !== entry.uid && existing.path !== entry.path
		);
		this.state.resourceIndex.push(entry);
		await this.plugin.saveState();
	}

	/** UIDs are global, so this finds the task whichever list it is in. */
	private async findPathForUid(uid: string): Promise<string | undefined> {
		const entry = this.state.resourceIndex.find((candidate) => candidate.uid === uid);
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
			serverUrl: account.serverUrl || account.lists[0]?.url || "",
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

/** Turns pulled fields into a TaskNotes update; null means the server has no value, so the field is cleared. */
function toTaskUpdate(
	changed: VTodoTaskPatch,
	local: TaskInfo,
	protectedTags: readonly string[]
): Partial<TaskInfo> {
	const updates: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(changed)) updates[key] = value ?? undefined;
	if (changed.tags) updates.tags = mergeRemoteTags(changed.tags, local.tags, protectedTags);
	return updates as Partial<TaskInfo>;
}

function routingFor(account: CalDavAccountSettings): AccountRouting {
	return {
		lists: account.lists.map(routeOf),
		defaultListId: account.defaultListId || undefined,
		excludeTags: account.excludeTags,
		folder: account.scopeFolder,
	};
}

function routeOf(list: CalDavTaskList): TaskListRoute {
	return { listId: list.id, tags: list.tags };
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
