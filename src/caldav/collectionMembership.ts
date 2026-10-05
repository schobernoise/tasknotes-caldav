/**
 * Decides which CalDAV task list a task belongs to.
 *
 * A task that belongs to a project goes to the account's project list, if it
 * has one. Every other task is routed by tag: rows are tried in order and a
 * task goes to the first whose tags it has, or else to the default list. A
 * task already in a list stays there as long as that list still claims it, so
 * a task matching two lists does not bounce between them.
 *
 * Project membership arrives resolved: following `projects` links to plain
 * notes, directly and up through parent tasks, needs Obsidian's metadata
 * cache, so CalDavSyncService walks them and passes the project paths in.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { TaskInfo } from "../tasknotes";

export interface TaskListRoute {
	listId: string;
	/** Tags with or without `#`; nested tags (`work/client`) also match `work`. */
	tags: readonly string[];
}

/** One link in a task's `projects` field, with the note it resolves to. */
export interface ProjectLink {
	link: string;
	path?: string;
}

export interface AccountRouting {
	/** In priority order. */
	lists: readonly TaskListRoute[];
	/** Takes tasks that match no list's tags; absent means they are not synced. */
	defaultListId?: string;
	/** Takes every task that belongs to a project, ahead of any tag. */
	projectListId?: string;
	/** Tasks that belong to a project are never synced; linked ones are released. */
	excludeProjectTasks?: boolean;
	/** Tasks with any of these are never picked up. */
	excludeTags?: readonly string[];
	/** Vault folders; tasks in subfolders match too. Empty means every folder. */
	includeFolders?: readonly string[];
	/** Tasks in any of these folders are never picked up. Wins over `includeFolders`. */
	excludeFolders?: readonly string[];
}

/**
 * The list a task should live in, or undefined when the account does not take it.
 *
 * `currentListId` is the list the task is linked to now, even one no longer in
 * `routing`. `projectPaths` are the plain project notes the task belongs to,
 * directly or through its parent tasks; any at all make it a project task.
 * Exclusions only stop unlinked tasks from being picked up: a linked task that
 * stops matching stays where it is rather than being deleted from the server
 * by a tag edit. See releasesTask for the exclusions that do take it out.
 */
export function routeTask(
	task: TaskInfo,
	routing: AccountRouting,
	currentListId?: string,
	projectPaths: readonly string[] = []
): string | undefined {
	const projectTask = projectPaths.length > 0;
	if (currentListId === undefined && !accountTakesTask(task, routing, projectTask)) return undefined;
	const projectList = routing.lists.find((list) => list.listId === projectListId(routing));
	if (projectTask && projectList) return projectList.listId;

	const matches = (list: TaskListRoute) => hasAnyTag(task, list.tags);
	const current = routing.lists.find((list) => list.listId === currentListId);
	if (current && listClaims(current, routing, matches)) return current.listId;

	const routed =
		routing.lists.find(matches) ??
		routing.lists.find((list) => list.listId === routing.defaultListId);
	if (routed) return routed.listId;
	if (current) return current.listId;
	return undefined;
}

/**
 * True when a linked task has to leave the server: its note sits in a
 * never-sync folder, or it belongs to a project while project tasks are not
 * synced. Unlike the other exclusions these apply to tasks already synced.
 */
export function releasesTask(path: string, routing: AccountRouting, projectPaths: readonly string[]): boolean {
	return inAnyFolder(path, routing.excludeFolders ?? []) || (Boolean(routing.excludeProjectTasks) && projectPaths.length > 0);
}

/**
 * Archived tasks are never picked up: archiving is how a remote deletion is
 * reflected locally, so re-uploading them would resurrect deleted VTODOs.
 */
function accountTakesTask(task: TaskInfo, routing: AccountRouting, projectTask: boolean): boolean {
	if (task.archived) return false;
	if (projectTask && routing.excludeProjectTasks) return false;
	if (hasAnyTag(task, routing.excludeTags ?? [])) return false;
	if (inAnyFolder(task.path, routing.excludeFolders ?? [])) return false;
	const included = normalizedFolders(routing.includeFolders ?? []);
	return included.length === 0 || inAnyFolder(task.path, included);
}

/**
 * What a task carries after moving between lists on the server: the old
 * list's routing tags go, and unless the task already qualifies for the new
 * list, it gains that list's first tag. Nested tags like `work/client` are the
 * user's own and stay. Moving out of the project list drops the task's
 * projects (`dropProjects`), or routing would send it straight back.
 */
export function rehomeForList(
	task: { tags: readonly string[]; projectTask: boolean },
	from: TaskListRoute | undefined,
	to: TaskListRoute,
	projectListId?: string
): { tags: string[]; dropProjects: boolean } {
	const dropProjects = from !== undefined && from.listId === projectListId && to.listId !== projectListId;
	const tags = task.tags.filter((tag) => !(from?.tags ?? []).some((route) => sameTag(route, tag)));
	const qualifies =
		tags.some((tag) => tagMatches(tag, to.tags)) || (to.listId === projectListId && task.projectTask);
	const [firstTag] = to.tags;
	return { tags: qualifies || !firstTag ? tags : [...tags, firstTag.replace(/^#/u, "")], dropProjects };
}

/**
 * A list keeps its task while the task still matches its tags. A list that
 * routes nothing by tag (typically the default) keeps it until another list
 * wants it, unless it is the project list, which only holds project tasks.
 */
function listClaims(
	list: TaskListRoute,
	routing: AccountRouting,
	matches: (list: TaskListRoute) => boolean
): boolean {
	const routesSomething =
		normalizedTags(list.tags).length > 0 ||
		(list.listId === projectListId(routing) && list.listId !== routing.defaultListId);
	if (routesSomething) return matches(list);
	return !routing.lists.some(matches);
}

/** The list project tasks go to; none while they are not synced at all. */
export function projectListId(routing: AccountRouting): string | undefined {
	return routing.excludeProjectTasks ? undefined : routing.projectListId || undefined;
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

function inAnyFolder(path: string, folders: readonly string[]): boolean {
	return normalizedFolders(folders).some((folder) => path.startsWith(`${folder}/`));
}

function normalizedFolders(folders: readonly string[]): string[] {
	return folders.map((folder) => folder.trim().replace(/^\/+|\/+$/gu, "")).filter(Boolean);
}

function normalizeTag(tag: string | undefined): string {
	return (tag ?? "").trim().replace(/^#/u, "").toLowerCase();
}
