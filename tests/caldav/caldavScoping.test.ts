import type { TaskInfo } from "../../src/tasknotes";
import {
	CALDAV_FRONTMATTER_KEYS,
	CALDAV_FRONTMATTER_KEY_LIST,
	getCalDavRelevantFingerprint,
	hasCalDavRelevantChange,
	parseCalDavFingerprint,
} from "../../src/caldav/caldavFingerprint";
import { rehomeForList, releasesTask, routeTask, type AccountRouting } from "../../src/caldav/collectionMembership";

function makeTask(overrides: Partial<TaskInfo> & Record<string, unknown> = {}): TaskInfo {
	return {
		title: "Buy groceries",
		status: "open",
		priority: "normal",
		path: "Tasks/buy-groceries.md",
		archived: false,
		...overrides,
	};
}

describe("getCalDavRelevantFingerprint", () => {
	it("is stable for an unchanged task", () => {
		const task = makeTask();
		expect(getCalDavRelevantFingerprint(task)).toBe(getCalDavRelevantFingerprint(task));
	});

	it("changes when user-visible content changes", () => {
		const before = getCalDavRelevantFingerprint(makeTask());
		expect(getCalDavRelevantFingerprint(makeTask({ title: "Something else" }))).not.toBe(
			before
		);
		expect(getCalDavRelevantFingerprint(makeTask({ status: "done" }))).not.toBe(before);
		expect(getCalDavRelevantFingerprint(makeTask({ due: "2025-09-03" }))).not.toBe(before);
	});

	it("does NOT change when only sync metadata is written", () => {
		// This is the property that breaks the write-back loop: stamping an ETag
		// into frontmatter must not look like a content edit.
		const before = getCalDavRelevantFingerprint(makeTask());
		const withMetadata = makeTask() as TaskInfo & Record<string, unknown>;
		for (const key of CALDAV_FRONTMATTER_KEY_LIST) {
			withMetadata[key] = "written-by-sync";
		}
		expect(getCalDavRelevantFingerprint(withMetadata)).toBe(before);
	});

	it("does not change when only dateModified or time tracking changes", () => {
		const before = getCalDavRelevantFingerprint(makeTask());
		expect(
			getCalDavRelevantFingerprint(
				makeTask({ dateModified: "2025-09-01T12:00:00Z", totalTrackedTime: 42 })
			)
		).toBe(before);
	});

	it("ignores tag reordering", () => {
		expect(getCalDavRelevantFingerprint(makeTask({ tags: ["a", "b"] }))).toBe(
			getCalDavRelevantFingerprint(makeTask({ tags: ["b", "a"] }))
		);
	});

	it("exposes the frontmatter keys the integration owns", () => {
		expect(CALDAV_FRONTMATTER_KEYS.uid).toBe("caldav_uid");
		expect(CALDAV_FRONTMATTER_KEY_LIST).toHaveLength(5);
		expect(CALDAV_FRONTMATTER_KEY_LIST.every((key) => key.startsWith("caldav_"))).toBe(true);
	});
});

describe("parseCalDavFingerprint", () => {
	it("round-trips a fingerprint back into a previous state", () => {
		const fingerprint = getCalDavRelevantFingerprint(
			makeTask({ title: "Old", status: "open" })
		);
		expect(parseCalDavFingerprint(fingerprint)).toMatchObject({
			title: "Old",
			status: "open",
		});
	});

	it("treats missing or corrupt fingerprints as no previous state", () => {
		expect(parseCalDavFingerprint(undefined)).toBeNull();
		expect(parseCalDavFingerprint("{not json")).toBeNull();
		expect(parseCalDavFingerprint("[1,2,3]")).toBeNull();
	});
});

describe("hasCalDavRelevantChange", () => {
	it("reports a change against no stored fingerprint", () => {
		expect(hasCalDavRelevantChange(makeTask(), undefined)).toBe(true);
	});

	it("reports no change for a metadata-only write", () => {
		const task = makeTask();
		expect(hasCalDavRelevantChange(task, getCalDavRelevantFingerprint(task))).toBe(false);
	});

	it("reports a change for a real edit", () => {
		const fingerprint = getCalDavRelevantFingerprint(makeTask());
		expect(hasCalDavRelevantChange(makeTask({ status: "done" }), fingerprint)).toBe(true);
	});
});

describe("routeTask", () => {
	const routing: AccountRouting = {
		lists: [
			{ listId: "work", tags: ["#Work", "client"] },
			{ listId: "home", tags: ["home"] },
			{ listId: "projects", tags: [] },
			{ listId: "personal", tags: [] },
		],
		defaultListId: "personal",
		projectListId: "projects",
	};
	const route = (
		overrides: Partial<TaskInfo>,
		current?: string,
		custom: Partial<AccountRouting> = {},
		projectPaths: string[] = []
	) => routeTask(makeTask(overrides), { ...routing, ...custom }, current, projectPaths);

	it("sends a task to the first list whose tags it has, case-insensitively and with or without #", () => {
		expect(route({ tags: ["work"] })).toBe("work");
		expect(route({ tags: ["#client"] })).toBe("work");
		expect(route({ tags: ["home"] })).toBe("home");
		expect(route({ tags: ["home", "work"] })).toBe("work");
	});

	it("matches nested tags but not name-prefixed ones", () => {
		expect(route({ tags: ["work/acme"] })).toBe("work");
		expect(route({ tags: ["workshop"] })).toBe("personal");
	});

	it("sends a task matching no list to the default, or nowhere without one", () => {
		expect(route({ tags: ["urgent"] })).toBe("personal");
		expect(route({})).toBe("personal");
		expect(route({ tags: ["urgent"] }, undefined, { defaultListId: undefined })).toBeUndefined();
	});

	it("keeps a task in its list while it still has one of that list's tags", () => {
		// No ping-pong: a Work task that gains #home stays in Work.
		expect(route({ tags: ["home", "work"] }, "home")).toBe("home");
		expect(route({ tags: ["work", "home"] }, "work")).toBe("work");
	});

	it("moves a task whose tags now point elsewhere", () => {
		expect(route({ tags: ["home"] }, "work")).toBe("home");
		expect(route({ tags: ["work"] }, "personal")).toBe("work");
	});

	it("moves a task that lost its list's tag to the default", () => {
		expect(route({ tags: ["urgent"] }, "work")).toBe("personal");
	});

	it("leaves a linked task where it is when nothing else takes it", () => {
		// A tag edit must never delete a task from the server.
		expect(route({ tags: ["urgent"] }, "work", { defaultListId: undefined })).toBe("work");
	});

	it("keeps a task in a list without tags until a tagged list wants it", () => {
		expect(route({ tags: ["urgent"] }, "personal")).toBe("personal");
		expect(route({ tags: ["home"] }, "personal")).toBe("home");
	});

	it("applies exclude tags and folders only to tasks not linked yet", () => {
		const custom = { excludeTags: ["private"], includeFolders: ["/Tasks/"], excludeFolders: ["Tasks/Old"] };
		expect(route({ tags: ["work", "private/health"] }, undefined, custom)).toBeUndefined();
		expect(route({ tags: ["work"], path: "Other/a.md" }, undefined, custom)).toBeUndefined();
		expect(route({ tags: ["work"], path: "Tasks/x/a.md" }, undefined, custom)).toBe("work");
		expect(route({ tags: ["work"], path: "Tasks/Old/x/a.md" }, undefined, custom)).toBeUndefined();
		expect(route({ tags: ["work", "private"] }, "work", custom)).toBe("work");
		expect(route({ tags: ["work"], path: "Tasks/Old/a.md" }, "work", custom)).toBe("work");
	});

	it("picks up tasks from any of several include folders", () => {
		const custom = { includeFolders: ["Tasks", "Projects/"] };
		expect(route({ path: "Tasks/a.md" }, undefined, custom)).toBe("personal");
		expect(route({ path: "Projects/p/a.md" }, undefined, custom)).toBe("personal");
		expect(route({ path: "Inbox/a.md" }, undefined, custom)).toBeUndefined();
	});

	it("lets an exclude folder alone keep tasks out of an otherwise unrestricted account", () => {
		expect(route({ path: "Archive/a.md" }, undefined, { excludeFolders: ["Archive"] })).toBeUndefined();
		expect(route({ path: "Tasks/a.md" }, undefined, { excludeFolders: ["Archive"] })).toBe("personal");
	});

	it("does not match a folder by name prefix", () => {
		expect(route({ path: "Tasks/Workshop/a.md" }, undefined, { includeFolders: ["Tasks/Work"] })).toBeUndefined();
		expect(route({ path: "Tasks/Workshop/a.md" }, undefined, { excludeFolders: ["Tasks/Work"] })).toBe("personal");
	});

	it("never picks up an archived task, but does not evict a linked one", () => {
		// Archiving is how a remote deletion is reflected locally; re-uploading
		// archived tasks would resurrect VTODOs the user deleted on the server.
		expect(route({ archived: true })).toBeUndefined();
		expect(route({ archived: true, tags: ["work"] }, "work")).toBe("work");
	});

	it("sends a project task to the project list, however it got its project", () => {
		// The service resolves links and parent tasks into these paths.
		expect(route({}, undefined, {}, ["Projects/Band.md"])).toBe("projects");
		expect(route({ tags: ["urgent"] }, undefined, {}, ["Projects/House.md"])).toBe("projects");
	});

	it("puts the project list ahead of tags, even the tags of the list a task is in", () => {
		expect(route({ tags: ["work"] }, undefined, {}, ["Projects/Band.md"])).toBe("projects");
		expect(route({ tags: ["work"] }, "work", {}, ["Projects/Band.md"])).toBe("projects");
	});

	it("routes project tasks by tag while there is no project list", () => {
		expect(route({ tags: ["work"] }, undefined, { projectListId: undefined }, ["Projects/Band.md"])).toBe("work");
		expect(route({}, undefined, { projectListId: undefined }, ["Projects/Band.md"])).toBe("personal");
	});

	it("moves a task that left its project out of a project list without tags", () => {
		expect(route({ tags: ["work"] }, "projects")).toBe("work");
		expect(route({}, "projects")).toBe("personal");
		expect(route({}, "projects", { defaultListId: undefined })).toBe("projects");
	});

	it("lets a project list that is also the default keep everything else", () => {
		const custom = { projectListId: "personal" };
		expect(route({}, undefined, custom, ["Projects/Band.md"])).toBe("personal");
		expect(route({}, "personal", custom)).toBe("personal");
		expect(route({ tags: ["home"] }, "personal", custom)).toBe("home");
	});

	it("keeps a project list with tags holding tasks that have them", () => {
		const custom = { lists: [...routing.lists.slice(0, 2), { listId: "projects", tags: ["gig"] }, routing.lists[3]] };
		expect(route({ tags: ["gig"] }, "projects", custom)).toBe("projects");
		expect(route({ tags: ["gig"] }, undefined, custom)).toBe("projects");
	});

	it("does not pick up project tasks while they are excluded, and ignores the project list then", () => {
		const custom = { excludeProjectTasks: true };
		expect(route({ tags: ["work"] }, undefined, custom, ["Projects/Band.md"])).toBeUndefined();
		expect(route({ tags: ["work"] }, undefined, custom)).toBe("work");
		expect(route({}, "projects", custom)).toBe("projects");
	});

	it("routes a task out of a removed list by its tags, ignoring exclusions since it is already on the server", () => {
		expect(route({ tags: ["home"] }, "gone")).toBe("home");
		expect(route({ tags: ["private"] }, "gone", { excludeTags: ["private"] })).toBe("personal");
	});
});

describe("releasesTask", () => {
	const routing: AccountRouting = { lists: [], excludeFolders: ["/attachments/", "Tasks/Old"] };

	it("releases notes in a never-sync folder or below it", () => {
		expect(releasesTask("attachments/templates/taskTemplate.md", routing, [])).toBe(true);
		expect(releasesTask("Tasks/Old/a.md", routing, [])).toBe(true);
	});

	it("ignores other folders, including ones that only share a name prefix", () => {
		expect(releasesTask("Tasks/a.md", routing, [])).toBe(false);
		expect(releasesTask("Tasks/Older/a.md", routing, [])).toBe(false);
		expect(releasesTask("attachments.md", routing, [])).toBe(false);
		expect(releasesTask("Tasks/a.md", { lists: [] }, [])).toBe(false);
	});

	it("releases project tasks only while project tasks are excluded", () => {
		expect(releasesTask("Tasks/a.md", routing, ["Projects/Band.md"])).toBe(false);
		expect(releasesTask("Tasks/a.md", { ...routing, excludeProjectTasks: true }, ["Projects/Band.md"])).toBe(true);
		expect(releasesTask("Tasks/a.md", { ...routing, excludeProjectTasks: true }, [])).toBe(false);
	});
});

describe("rehomeForList", () => {
	const work = { listId: "work", tags: ["work", "client"] };
	const home = { listId: "home", tags: ["#home", "errand"] };
	const projects = { listId: "projects", tags: [] };
	const gigs = { listId: "projects", tags: ["gig"] };
	const personal = { listId: "personal", tags: [] };
	const rehome = (tags: string[], from: typeof work | undefined, to: typeof work, projectTask = false) =>
		rehomeForList({ tags, projectTask }, from, to, "projects");
	const retag = (tags: string[], from: typeof work | undefined, to: typeof work) => rehome(tags, from, to).tags;

	it("swaps the old list's routing tags for the new list's first tag", () => {
		expect(retag(["task", "Work", "urgent"], work, home)).toEqual(["task", "urgent", "home"]);
	});

	it("keeps nested tags, which are the user's own", () => {
		expect(retag(["work/acme"], work, home)).toEqual(["work/acme", "home"]);
	});

	it("adds nothing when the task already qualifies for the new list", () => {
		expect(retag(["errand"], work, home)).toEqual(["errand"]);
		expect(retag(["home/garden"], undefined, home)).toEqual(["home/garden"]);
	});

	it("adds nothing for a list without tags", () => {
		expect(retag(["work", "urgent"], work, personal)).toEqual(["urgent"]);
		expect(retag(["urgent"], undefined, personal)).toEqual(["urgent"]);
	});

	it("tags an import into a tagged list", () => {
		expect(retag([], undefined, work)).toEqual(["work"]);
	});

	it("tags a task moved into a tagged project list only when it has no project", () => {
		expect(rehome([], work, gigs, true).tags).toEqual([]);
		expect(rehome([], work, gigs, false).tags).toEqual(["gig"]);
	});

	it("drops the projects of a task moved out of the project list, and only then", () => {
		expect(rehome([], projects, home, true)).toEqual({ tags: ["home"], dropProjects: true });
		expect(rehome([], home, projects, true).dropProjects).toBe(false);
		expect(rehome([], work, home, true).dropProjects).toBe(false);
		expect(rehome([], undefined, home, true).dropProjects).toBe(false);
	});
});
