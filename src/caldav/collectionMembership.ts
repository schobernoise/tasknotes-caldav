/**
 * Decides which CalDAV collection a task belongs to.
 *
 * Each account can be scoped by a tag, a folder, or both (both must match).
 * An account with neither takes every task.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { TaskInfo } from "../tasknotes";

export interface CalDavCollectionScope {
	/** Stable id of the configured account/collection. */
	accountId: string;
	/** Tag without the leading `#`; nested tags (`work/client`) also match `work`. */
	tag?: string;
	/** Vault folder; tasks in subfolders match too. */
	folder?: string;
}

export function taskBelongsToCollection(task: TaskInfo, scope: CalDavCollectionScope): boolean {
	// Archived tasks are never pushed; archiving is how a remote deletion is
	// reflected locally, so re-uploading them would resurrect deleted VTODOs.
	if (task.archived) return false;
	return matchesTag(task, scope.tag) && matchesFolder(task, scope.folder);
}

/**
 * Resolves the single collection that owns a task.
 *
 * Scopes are evaluated in configured order and the first match wins, so a task
 * matching two collections is uploaded once rather than duplicated across both.
 */
export function resolveCollectionForTask(
	task: TaskInfo,
	scopes: readonly CalDavCollectionScope[]
): CalDavCollectionScope | undefined {
	return scopes.find((scope) => taskBelongsToCollection(task, scope));
}

function matchesTag(task: TaskInfo, tag: string | undefined): boolean {
	const wanted = normalizeTag(tag);
	if (!wanted) return true;
	return (task.tags ?? []).some((candidate) => {
		const have = normalizeTag(candidate);
		return have === wanted || have.startsWith(`${wanted}/`);
	});
}

function matchesFolder(task: TaskInfo, folder: string | undefined): boolean {
	const wanted = (folder ?? "").trim().replace(/^\/+|\/+$/gu, "");
	if (!wanted) return true;
	return task.path.startsWith(`${wanted}/`);
}

function normalizeTag(tag: string | undefined): string {
	return (tag ?? "").trim().replace(/^#/u, "").toLowerCase();
}
