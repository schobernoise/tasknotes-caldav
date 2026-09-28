import type { TaskInfo } from "../../src/tasknotes";
import {
	CALDAV_FRONTMATTER_KEYS,
	CALDAV_FRONTMATTER_KEY_LIST,
	getCalDavRelevantFingerprint,
	hasCalDavRelevantChange,
	parseCalDavFingerprint,
} from "../../src/caldav/caldavFingerprint";
import {
	resolveCollectionForTask,
	taskBelongsToCollection,
	type CalDavCollectionScope,
} from "../../src/caldav/collectionMembership";

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

describe("taskBelongsToCollection", () => {
	it("matches every task when the scope has no tag or folder", () => {
		expect(taskBelongsToCollection(makeTask(), { accountId: "a" })).toBe(true);
		expect(taskBelongsToCollection(makeTask(), { accountId: "a", tags: [" "], folder: "" })).toBe(
			true
		);
	});

	it("matches a tag with or without #, case-insensitively, including nested tags", () => {
		const scope: CalDavCollectionScope = { accountId: "work", tags: ["#Work"] };
		expect(taskBelongsToCollection(makeTask({ tags: ["work"] }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask({ tags: ["#work/client"] }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask({ tags: ["workshop"] }), scope)).toBe(false);
		expect(taskBelongsToCollection(makeTask({ tags: ["personal"] }), scope)).toBe(false);
		expect(taskBelongsToCollection(makeTask(), scope)).toBe(false);
	});

	it("includes a task carrying any one of several tags", () => {
		const scope: CalDavCollectionScope = { accountId: "a", tags: ["work", "errand"] };
		expect(taskBelongsToCollection(makeTask({ tags: ["errand"] }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask({ tags: ["home"] }), scope)).toBe(false);
	});

	it("in exclude mode, skips tasks with any listed tag and keeps the rest", () => {
		const scope: CalDavCollectionScope = {
			accountId: "a",
			tags: ["private", "someday"],
			tagMode: "exclude",
		};
		expect(taskBelongsToCollection(makeTask({ tags: ["private/health"] }), scope)).toBe(false);
		expect(taskBelongsToCollection(makeTask({ tags: ["work", "someday"] }), scope)).toBe(false);
		expect(taskBelongsToCollection(makeTask({ tags: ["work"] }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask(), scope)).toBe(true);
	});

	it("in exclude mode with an empty list, restricts nothing", () => {
		const scope: CalDavCollectionScope = { accountId: "a", tags: [], tagMode: "exclude" };
		expect(taskBelongsToCollection(makeTask({ tags: ["private"] }), scope)).toBe(true);
	});

	it("matches a folder and its subfolders, not name-prefixed siblings", () => {
		const scope: CalDavCollectionScope = { accountId: "a", folder: "/Tasks/Work/" };
		expect(taskBelongsToCollection(makeTask({ path: "Tasks/Work/a.md" }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask({ path: "Tasks/Work/x/a.md" }), scope)).toBe(true);
		expect(taskBelongsToCollection(makeTask({ path: "Tasks/Workshop/a.md" }), scope)).toBe(false);
		expect(taskBelongsToCollection(makeTask({ path: "Tasks/a.md" }), scope)).toBe(false);
	});

	it("requires both tag and folder when both are set", () => {
		const scope: CalDavCollectionScope = { accountId: "a", tags: ["work"], folder: "Tasks" };
		expect(taskBelongsToCollection(makeTask({ tags: ["work"] }), scope)).toBe(true);
		expect(
			taskBelongsToCollection(makeTask({ tags: ["work"], path: "Other/a.md" }), scope)
		).toBe(false);
		expect(taskBelongsToCollection(makeTask({ tags: ["home"] }), scope)).toBe(false);
	});

	it("never includes an archived task", () => {
		// Archiving is how a remote deletion is reflected locally; re-uploading
		// archived tasks would resurrect VTODOs the user deleted on the server.
		expect(taskBelongsToCollection(makeTask({ archived: true }), { accountId: "a" })).toBe(
			false
		);
	});
});

describe("resolveCollectionForTask", () => {
	const scopes: CalDavCollectionScope[] = [
		{ accountId: "work", tags: ["work"] },
		{ accountId: "personal", tags: ["personal"] },
		{ accountId: "catch-all" },
	];

	it("returns the first matching collection", () => {
		expect(resolveCollectionForTask(makeTask({ tags: ["personal"] }), scopes)?.accountId).toBe(
			"personal"
		);
	});

	it("assigns a task to exactly one collection when several match", () => {
		// Order decides, so a task is uploaded once rather than duplicated.
		expect(
			resolveCollectionForTask(makeTask({ tags: ["work", "personal"] }), scopes)?.accountId
		).toBe("work");
	});

	it("falls through to an unscoped collection", () => {
		expect(resolveCollectionForTask(makeTask({ tags: ["other"] }), scopes)?.accountId).toBe(
			"catch-all"
		);
	});

	it("returns undefined when nothing matches", () => {
		expect(
			resolveCollectionForTask(makeTask({ tags: ["other"] }), scopes.slice(0, 2))
		).toBeUndefined();
	});
});
