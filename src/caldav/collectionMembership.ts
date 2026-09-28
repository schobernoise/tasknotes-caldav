/**
 * Decides which CalDAV collection a task belongs to.
 *
 * Each account can be scoped by a tag list (include: any of them; exclude:
 * none of them), a folder, or both (both must hold). An account with neither
 * takes every task.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { TaskInfo } from "../tasknotes";

export interface CalDavCollectionScope {
	/** Stable id of the configured account/collection. */
	accountId: string;
	/** Tags with or without `#`; nested tags (`work/client`) also match `work`. */
	tags?: readonly string[];
	/** `include`: the task needs one of `tags`. `exclude`: it must have none. */
	tagMode?: "include" | "exclude";
	/** Vault folder; tasks in subfolders match too. */
	folder?: string;
}

export function taskBelongsToCollection(task: TaskInfo, scope: CalDavCollectionScope): boolean {
	// Archived tasks are never pushed; archiving is how a remote deletion is
	// reflected locally, so re-uploading them would resurrect deleted VTODOs.
	if (task.archived) return false;
	return matchesTags(task, scope.tags, scope.tagMode ?? "include") && matchesFolder(task, scope.folder);
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

function matchesTags(
	task: TaskInfo,
	tags: readonly string[] | undefined,
	mode: "include" | "exclude"
): boolean {
	const wanted = (tags ?? []).map(normalizeTag).filter(Boolean);
	if (wanted.length === 0) return true;
	const hasAny = (task.tags ?? []).some((candidate) => {
		const have = normalizeTag(candidate);
		return wanted.some((tag) => have === tag || have.startsWith(`${tag}/`));
	});
	return mode === "include" ? hasAny : !hasAny;
}

function matchesFolder(task: TaskInfo, folder: string | undefined): boolean {
	const wanted = (folder ?? "").trim().replace(/^\/+|\/+$/gu, "");
	if (!wanted) return true;
	return task.path.startsWith(`${wanted}/`);
}

function normalizeTag(tag: string | undefined): string {
	return (tag ?? "").trim().replace(/^#/u, "").toLowerCase();
}
