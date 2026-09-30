/**
 * Decides which CalDAV task list a task belongs to.
 *
 * An account routes tasks to its lists by tag or project: rows are tried in
 * order and a task goes to the first whose tags it has or whose projects it
 * belongs to, or else to the default list. A task already in a list stays
 * there as long as that list still claims it, so a task matching two lists
 * does not bounce between them.
 *
 * Project membership arrives resolved: following `projects` links to notes
 * and up through parent tasks needs Obsidian's metadata cache, so
 * CalDavSyncService walks them and passes the paths in.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { TaskInfo } from "../tasknotes";

export interface TaskListRoute {
	listId: string;
	/** Tags with or without `#`; nested tags (`work/client`) also match `work`. */
	tags: readonly string[];
	/** Vault paths of project notes. */
	projects: readonly string[];
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
 * `routing`. `projectPaths` are the project notes the task belongs to,
 * directly or through its parent tasks. Exclusions only stop unlinked tasks
 * from being picked up: a linked task that stops matching stays where it is
 * rather than being deleted from the server by a tag edit.
 */
export function routeTask(
	task: TaskInfo,
	routing: AccountRouting,
	currentListId?: string,
	projectPaths: readonly string[] = []
): string | undefined {
	if (currentListId === undefined && !accountTakesTask(task, routing)) return undefined;
	const matches = (list: TaskListRoute) => listMatches(task, list, projectPaths);
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
 * True when a note sits in one of the account's never-sync folders. Unlike
 * every other exclusion this also applies to tasks already synced: moving a
 * note into such a folder is how a task is taken out of sync.
 */
export function inExcludedFolder(path: string, routing: AccountRouting): boolean {
	return inAnyFolder(path, routing.excludeFolders ?? []);
}

/**
 * Archived tasks are never picked up: archiving is how a remote deletion is
 * reflected locally, so re-uploading them would resurrect deleted VTODOs.
 */
function accountTakesTask(task: TaskInfo, routing: AccountRouting): boolean {
	if (task.archived) return false;
	if (hasAnyTag(task, routing.excludeTags ?? [])) return false;
	if (inAnyFolder(task.path, routing.excludeFolders ?? [])) return false;
	const included = normalizedFolders(routing.includeFolders ?? []);
	return included.length === 0 || inAnyFolder(task.path, included);
}

/**
 * What a task carries after moving between lists on the server: the old
 * list's routing tags and direct links to its projects go, and unless the
 * task already qualifies for the new list, it gains that list's first tag, or
 * a link to its first project when the list routes by project alone. Nested
 * tags like `work/client` are the user's own and stay.
 */
export function rehomeForList(
	task: { tags: readonly string[]; projects: readonly ProjectLink[]; projectPaths: readonly string[] },
	from: TaskListRoute | undefined,
	to: TaskListRoute,
	linkTo: (path: string) => string
): { tags: string[]; projects: string[] } {
	const leaving = from?.projects ?? [];
	const tags = task.tags.filter((tag) => !(from?.tags ?? []).some((route) => sameTag(route, tag)));
	const projects = task.projects
		.filter((project) => !project.path || !leaving.includes(project.path))
		.map((project) => project.link);
	const projectPaths = task.projectPaths.filter((path) => !leaving.includes(path));
	if (tags.some((tag) => tagMatches(tag, to.tags)) || projectPaths.some((path) => to.projects.includes(path))) {
		return { tags, projects };
	}

	const [firstTag] = to.tags;
	if (firstTag) return { tags: [...tags, firstTag.replace(/^#/u, "")], projects };
	const [firstProject] = to.projects;
	if (firstProject) return { tags, projects: [...projects, linkTo(firstProject)] };
	return { tags, projects };
}

/**
 * A list keeps its task while the task still matches it. A list without tags
 * or projects (typically the default) keeps it until another list wants it.
 */
function listClaims(
	list: TaskListRoute,
	routing: AccountRouting,
	matches: (list: TaskListRoute) => boolean
): boolean {
	if (normalizedTags(list.tags).length > 0 || list.projects.length > 0) return matches(list);
	return !routing.lists.some(matches);
}

function listMatches(task: TaskInfo, list: TaskListRoute, projectPaths: readonly string[]): boolean {
	return hasAnyTag(task, list.tags) || list.projects.some((path) => projectPaths.includes(path));
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
