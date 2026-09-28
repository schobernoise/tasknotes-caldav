/**
 * Decides which CalDAV task list a task belongs to.
 *
 * An account routes tasks to its lists by tag: rows are tried in order and a
 * task goes to the first whose tags it has, or else to the default list. A
 * task already in a list stays there as long as that list still claims it, so
 * a task tagged for two lists does not bounce between them.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { TaskInfo } from "../tasknotes";

export interface TaskListRoute {
	listId: string;
	/** Tags with or without `#`; nested tags (`work/client`) also match `work`. */
	tags: readonly string[];
}

export interface AccountRouting {
	/** In priority order. */
	lists: readonly TaskListRoute[];
	/** Takes tasks that match no list's tags; absent means they are not synced. */
	defaultListId?: string;
	/** Tasks with any of these are never picked up. */
	excludeTags?: readonly string[];
	/** Vault folder; tasks in subfolders match too. */
	folder?: string;
}

/**
 * The list a task should live in, or undefined when the account does not take it.
 *
 * `currentListId` is the list the task is linked to now, even one no longer in
 * `routing`. Exclusions only stop unlinked tasks from being picked up: a
 * linked task that stops matching stays where it is rather than being deleted
 * from the server by a tag edit.
 */
export function routeTask(
	task: TaskInfo,
	routing: AccountRouting,
	currentListId?: string
): string | undefined {
	if (currentListId === undefined && !accountTakesTask(task, routing)) return undefined;
	const current = routing.lists.find((list) => list.listId === currentListId);
	if (current && listClaims(task, current, routing)) return current.listId;

	const routed =
		routing.lists.find((list) => hasAnyTag(task, list.tags)) ??
		routing.lists.find((list) => list.listId === routing.defaultListId);
	if (routed) return routed.listId;
	if (current) return current.listId;
	return undefined;
}

/**
 * Archived tasks are never picked up: archiving is how a remote deletion is
 * reflected locally, so re-uploading them would resurrect deleted VTODOs.
 */
function accountTakesTask(task: TaskInfo, routing: AccountRouting): boolean {
	if (task.archived) return false;
	if (hasAnyTag(task, routing.excludeTags ?? [])) return false;
	return matchesFolder(task, routing.folder);
}

/**
 * The tags a task should carry after moving between lists on the server:
 * the old list's routing tags go, and the new list's first tag is added unless
 * the task already qualifies for it. Nested tags like `work/client` are the
 * user's own and stay.
 */
export function retagForList(
	tags: readonly string[],
	from: TaskListRoute | undefined,
	to: TaskListRoute
): string[] {
	const kept = tags.filter((tag) => !(from?.tags ?? []).some((route) => sameTag(route, tag)));
	const [first] = to.tags;
	if (!first || kept.some((tag) => tagMatches(tag, to.tags))) return kept;
	return [...kept, first.replace(/^#/u, "")];
}

/**
 * A list keeps its task while the task has one of its tags. A list without
 * tags (typically the default) keeps it until a tagged list wants it.
 */
function listClaims(task: TaskInfo, list: TaskListRoute, routing: AccountRouting): boolean {
	if (normalizedTags(list.tags).length > 0) return hasAnyTag(task, list.tags);
	return !routing.lists.some((other) => hasAnyTag(task, other.tags));
}

function hasAnyTag(task: TaskInfo, tags: readonly string[]): boolean {
	return (task.tags ?? []).some((tag) => tagMatches(tag, tags));
}

function tagMatches(candidate: string, tags: readonly string[]): boolean {
	const have = normalizeTag(candidate);
	return normalizedTags(tags).some((tag) => have === tag || have.startsWith(`${tag}/`));
}

function sameTag(a: string, b: string): boolean {
	return normalizeTag(a) === normalizeTag(b);
}

function normalizedTags(tags: readonly string[]): string[] {
	return tags.map(normalizeTag).filter(Boolean);
}

function matchesFolder(task: TaskInfo, folder: string | undefined): boolean {
	const wanted = (folder ?? "").trim().replace(/^\/+|\/+$/gu, "");
	if (!wanted) return true;
	return task.path.startsWith(`${wanted}/`);
}

function normalizeTag(tag: string | undefined): string {
	return (tag ?? "").trim().replace(/^#/u, "").toLowerCase();
}
