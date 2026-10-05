import { DEFAULT_PRIORITIES, DEFAULT_STATUSES } from "../fixtures";
import type { TaskInfo } from "../../src/tasknotes";
import {
	applyTaskToVTodo,
	changedFields,
	defaultPriorityScale,
	hasStalePriority,
	hasStaleProjects,
	joinRecurrence,
	mergeRemoteTags,
	parseProjectPrefix,
	priorityScale,
	reconcileStartAndDue,
	readVTodoIntoTaskPatch,
	readVTodoRevision,
	readVTodoUid,
	splitRecurrence,
	taskPriorityToVTodo,
	taskStatusToVTodo,
	vTodoPriorityToTaskPriority,
	vTodoStatusToTaskStatus,
	type VTodoMappingContext,
} from "../../src/caldav/vtodoMapping";
import {
	createVTodoDocument,
	getProperty,
	getTextProperty,
	setTextProperty,
	parseVTodoDocument,
	serializeVTodoDocument,
} from "../../src/caldav/vtodoDocument";

const context: VTodoMappingContext = {
	statuses: DEFAULT_STATUSES,
	priorities: DEFAULT_PRIORITIES,
};

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Buy groceries",
		status: "open",
		priority: "normal",
		path: "Tasks/buy-groceries.md",
		archived: false,
		...overrides,
	};
}

describe("status mapping", () => {
	it("derives COMPLETED from the isCompleted flag", () => {
		expect(taskStatusToVTodo("done", context)).toBe("COMPLETED");
	});

	it("maps every other default status to NEEDS-ACTION", () => {
		expect(taskStatusToVTodo("open", context)).toBe("NEEDS-ACTION");
		expect(taskStatusToVTodo("in-progress", context)).toBe("NEEDS-ACTION");
		expect(taskStatusToVTodo("none", context)).toBe("NEEDS-ACTION");
	});

	it("maps an isSkipped status to CANCELLED", () => {
		const withSkipped: VTodoMappingContext = {
			...context,
			statuses: [
				...DEFAULT_STATUSES,
				{ value: "cancelled", isCompleted: false, isSkipped: true, order: 4 },
			],
		};
		expect(taskStatusToVTodo("cancelled", withSkipped)).toBe("CANCELLED");
		expect(vTodoStatusToTaskStatus("CANCELLED", withSkipped)).toBe("cancelled");
	});

	it("honours an explicit override in both directions", () => {
		const overridden: VTodoMappingContext = {
			...context,
			statusOverrides: { "in-progress": "IN-PROCESS" },
		};
		expect(taskStatusToVTodo("in-progress", overridden)).toBe("IN-PROCESS");
		expect(vTodoStatusToTaskStatus("IN-PROCESS", overridden)).toBe("in-progress");
	});

	it("maps inbound statuses to sensible defaults with no override", () => {
		expect(vTodoStatusToTaskStatus("COMPLETED", context)).toBe("done");
		expect(vTodoStatusToTaskStatus("NEEDS-ACTION", context)).toBe("none");
	});

	it("ignores an unknown inbound status rather than guessing", () => {
		expect(vTodoStatusToTaskStatus("NONSENSE", context)).toBeUndefined();
		expect(vTodoStatusToTaskStatus("", context)).toBeUndefined();
	});

	it("falls back to CANCELLED -> a completed status when nothing is skipped", () => {
		// The default configuration has no isSkipped status.
		expect(vTodoStatusToTaskStatus("CANCELLED", context)).toBe("done");
	});
});

describe("priority mapping", () => {
	// P0 highest, P4 the zero-weight "none", as in a vault with Todoist-style priorities.
	const numbered: VTodoMappingContext = {
		...context,
		priorities: [
			{ value: "P4", weight: 0 },
			{ value: "P3", weight: 1 },
			{ value: "P2", weight: 2 },
			{ value: "P1", weight: 3 },
			{ value: "P0", weight: 4 },
		],
	};

	it("maps three priorities onto high, medium and low", () => {
		expect(taskPriorityToVTodo("high", context)).toBe(1);
		expect(taskPriorityToVTodo("normal", context)).toBe(5);
		expect(taskPriorityToVTodo("low", context)).toBe(9);
	});

	it("puts the lowest weight at low, the next at medium and spreads the rest over high", () => {
		expect([...defaultPriorityScale(numbered.priorities)]).toEqual([
			["P4", 0],
			["P0", 1],
			["P1", 4],
			["P2", 5],
			["P3", 9],
		]);
	});

	it("treats the zero-weight priority as no PRIORITY at all", () => {
		expect(taskPriorityToVTodo("none", context)).toBeUndefined();
		expect(taskPriorityToVTodo("P4", numbered)).toBeUndefined();
	});

	it("round-trips every priority", () => {
		for (const ctx of [context, numbered]) {
			for (const { value } of ctx.priorities) {
				expect(vTodoPriorityToTaskPriority(taskPriorityToVTodo(value, ctx), ctx)).toBe(value);
			}
		}
	});

	it("reads other values by their RFC 5545 band first", () => {
		const read = (n: number) => vTodoPriorityToTaskPriority(n, numbered);
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(read)).toEqual(["P0", "P0", "P1", "P1", "P2", "P3", "P3", "P3", "P3"]);
		expect(vTodoPriorityToTaskPriority(4, context)).toBe("high");
		expect(vTodoPriorityToTaskPriority(6, context)).toBe("low");
	});

	it("falls back to the nearest priority when a band has none, ties going to the higher", () => {
		const two: VTodoMappingContext = { ...context, priorities: [{ value: "a", weight: 2 }, { value: "b", weight: 1 }] };
		expect(vTodoPriorityToTaskPriority(1, two)).toBe("a");
		expect(vTodoPriorityToTaskPriority(7, two)).toBe("b");
		const ends: VTodoMappingContext = { ...two, priorityMap: { a: 1, b: 9 } };
		expect(vTodoPriorityToTaskPriority(5, ends)).toBe("a");
	});

	it("reads 0 and an absent PRIORITY as the zero-weight priority, and garbage as nothing", () => {
		expect(vTodoPriorityToTaskPriority(0, numbered)).toBe("P4");
		expect(vTodoPriorityToTaskPriority(undefined, numbered)).toBe("P4");
		expect(vTodoPriorityToTaskPriority(42, numbered)).toBeUndefined();
		expect(vTodoPriorityToTaskPriority(Number.NaN, numbered)).toBeUndefined();
	});

	it("leaves 0 unread when no priority means none", () => {
		const weighted: VTodoMappingContext = { ...context, priorities: [{ value: "p", weight: 1 }] };
		expect(vTodoPriorityToTaskPriority(0, weighted)).toBeUndefined();
	});

	it("applies the user's choices over the defaults, ignoring invalid and unknown ones", () => {
		const custom: VTodoMappingContext = { ...numbered, priorityMap: { P1: 3, P2: 12, gone: 1 } };
		expect(taskPriorityToVTodo("P1", custom)).toBe(3);
		expect(taskPriorityToVTodo("P2", custom)).toBe(5);
		expect([...priorityScale(custom.priorities, custom.priorityMap).keys()]).not.toContain("gone");
	});

	it("lets two priorities share a number and reads it as the higher one", () => {
		const shared: VTodoMappingContext = { ...numbered, priorityMap: { P1: 1 } };
		expect(vTodoPriorityToTaskPriority(1, shared)).toBe("P0");
	});

	it("handles a single configured priority without dividing by zero", () => {
		const single: VTodoMappingContext = {
			...context,
			priorities: [{ value: "p", weight: 1 }],
		};
		expect(taskPriorityToVTodo("p", single)).toBe(5);
		expect(vTodoPriorityToTaskPriority(5, single)).toBe("p");
	});

	it("clears a note's priority when the server drops PRIORITY", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ priority: "P2" }), numbered, { uid: "u" });
		expect(getProperty(doc, "PRIORITY")?.value).toBe("5");
		setTextProperty(doc, "PRIORITY", "0");
		expect(readVTodoIntoTaskPatch(doc, numbered).priority).toBe("P4");
	});

	it("spots a PRIORITY written under an older scale", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ priority: "P2" }), numbered, { uid: "u" });
		expect(hasStalePriority(doc, makeTask({ priority: "P2" }), numbered)).toBe(false);
		setTextProperty(doc, "PRIORITY", "6");
		expect(hasStalePriority(doc, makeTask({ priority: "P2" }), numbered)).toBe(true);
		const none = createVTodoDocument();
		applyTaskToVTodo(none, makeTask({ priority: "P4" }), numbered, { uid: "u" });
		expect(hasStalePriority(none, makeTask({ priority: "P4" }), numbered)).toBe(false);
	});
});

describe("recurrence", () => {
	it("splits an embedded DTSTART out of the TaskNotes form", () => {
		expect(splitRecurrence("DTSTART:20240115;FREQ=WEEKLY;BYDAY=MO,TU")).toEqual({
			dtstart: "20240115",
			rule: "FREQ=WEEKLY;BYDAY=MO,TU",
		});
	});

	it("handles a rule with no DTSTART", () => {
		expect(splitRecurrence("FREQ=DAILY")).toEqual({ rule: "FREQ=DAILY" });
	});

	it("strips an RRULE: prefix", () => {
		expect(splitRecurrence("RRULE:FREQ=DAILY").rule).toBe("FREQ=DAILY");
	});

	it("rejoins into the TaskNotes form", () => {
		expect(joinRecurrence("20240115", "FREQ=WEEKLY")).toBe(
			"DTSTART:20240115;FREQ=WEEKLY"
		);
		expect(joinRecurrence(undefined, "FREQ=WEEKLY")).toBe("FREQ=WEEKLY");
	});

	it("round-trips through a VTODO", () => {
		const doc = createVTodoDocument();
		const task = makeTask({
			recurrence: "DTSTART:20240115;FREQ=WEEKLY;BYDAY=MO",
			scheduled: undefined,
		});
		applyTaskToVTodo(doc, task, context, { uid: "u1" });

		expect(getProperty(doc, "RRULE")?.value).toBe("FREQ=WEEKLY;BYDAY=MO");
		expect(getProperty(doc, "DTSTART")?.value).toBe("20240115");

		const patch = readVTodoIntoTaskPatch(doc, context);
		expect(patch.recurrence).toBe("DTSTART:20240115;FREQ=WEEKLY;BYDAY=MO");
	});
});

describe("applyTaskToVTodo", () => {
	it("writes the fields TaskNotes owns", () => {
		const doc = createVTodoDocument();
		const task = makeTask({
			title: "Buy groceries",
			due: "2025-09-03",
			priority: "high",
			tags: ["errands", "shopping"],
		});
		applyTaskToVTodo(doc, task, context, { uid: "uid-1", now: "2025-09-01T12:00:00Z" });

		expect(getTextProperty(doc, "UID")).toBe("uid-1");
		expect(getTextProperty(doc, "SUMMARY")).toBe("Buy groceries");
		expect(getProperty(doc, "DUE")).toMatchObject({
			value: "20250903",
			params: { VALUE: "DATE" },
		});
		expect(getProperty(doc, "STATUS")?.value).toBe("NEEDS-ACTION");
		expect(getProperty(doc, "PRIORITY")?.value).toBe("1");
		expect(getProperty(doc, "DTSTAMP")?.value).toBe("20250901T120000Z");
		expect(getProperty(doc, "CATEGORIES")?.value).toBe("errands,shopping");
	});

	it("leaves hidden tags out of CATEGORIES, matching case- and #-insensitively", () => {
		const doc = createVTodoDocument();
		const task = makeTask({ tags: ["notiz/task", "errands"] });
		applyTaskToVTodo(doc, task, { ...context, hiddenTags: ["#Notiz/Task"] }, { uid: "uid-1" });
		expect(getProperty(doc, "CATEGORIES")?.value).toBe("errands");
	});

	it("drops CATEGORIES entirely when only hidden tags remain", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ tags: ["task"] }), { ...context, hiddenTags: ["task"] }, { uid: "uid-1" });
		expect(getProperty(doc, "CATEGORIES")).toBeUndefined();
	});

	it("writes COMPLETED and PERCENT-COMPLETE for a done task", () => {
		const doc = createVTodoDocument();
		const task = makeTask({ status: "done", completedDate: "2025-09-02" });
		applyTaskToVTodo(doc, task, context, { uid: "uid-1", now: "2025-09-02T09:00:00Z" });

		expect(getProperty(doc, "STATUS")?.value).toBe("COMPLETED");
		expect(getProperty(doc, "PERCENT-COMPLETE")?.value).toBe("100");
		// RFC 5545 requires COMPLETED to be a UTC date-time.
		expect(getProperty(doc, "COMPLETED")?.value).toBe("20250902T000000Z");
	});

	it("clears COMPLETED when a task is reopened", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ status: "done", completedDate: "2025-09-02" }), context, {
			uid: "uid-1",
		});
		expect(getProperty(doc, "COMPLETED")).toBeDefined();

		applyTaskToVTodo(doc, makeTask({ status: "open" }), context, { uid: "uid-1" });
		expect(getProperty(doc, "COMPLETED")).toBeUndefined();
		expect(getProperty(doc, "PERCENT-COMPLETE")).toBeUndefined();
		expect(getProperty(doc, "STATUS")?.value).toBe("NEEDS-ACTION");
	});

	it("removes DUE when a task's due date is cleared", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ due: "2025-09-03" }), context, { uid: "u" });
		expect(getProperty(doc, "DUE")).toBeDefined();

		applyTaskToVTodo(doc, makeTask({ due: undefined }), context, { uid: "u" });
		expect(getProperty(doc, "DUE")).toBeUndefined();
	});

	it("bumps SEQUENCE on each write", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask(), context, { uid: "u" });
		expect(getProperty(doc, "SEQUENCE")?.value).toBe("1");
		applyTaskToVTodo(doc, makeTask(), context, { uid: "u" });
		expect(getProperty(doc, "SEQUENCE")?.value).toBe("2");
	});

	it("leaves properties it does not own untouched", () => {
		const remote = [
			"BEGIN:VCALENDAR",
			"BEGIN:VTODO",
			"UID:remote-uid",
			"SUMMARY:Old title",
			"DESCRIPTION:A long note body written on the phone",
			"X-APPLE-SORT-ORDER:987",
			"RELATED-TO;RELTYPE=PARENT:parent-uid",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER:-PT15M",
			"END:VALARM",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");

		const doc = parseVTodoDocument(remote)!;
		applyTaskToVTodo(doc, makeTask({ title: "New title" }), context, {
			uid: "remote-uid",
		});
		const out = serializeVTodoDocument(doc);

		expect(out).toContain("SUMMARY:New title");
		expect(out).toContain("DESCRIPTION:A long note body written on the phone");
		expect(out).toContain("X-APPLE-SORT-ORDER:987");
		expect(out).toContain("RELATED-TO;RELTYPE=PARENT:parent-uid");
		expect(out).toContain("BEGIN:VALARM");
		expect(out).toContain("TRIGGER:-PT15M");
	});
});

describe("readVTodoIntoTaskPatch", () => {
	it("reads a server-authored VTODO", () => {
		const doc = parseVTodoDocument(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VTODO",
				"UID:abc",
				"SUMMARY:Call the dentist",
				"DUE;VALUE=DATE:20250910",
				"STATUS:NEEDS-ACTION",
				"PRIORITY:1",
				"CATEGORIES:health,calls",
				"END:VTODO",
				"END:VCALENDAR",
			].join("\r\n")
		)!;

		expect(readVTodoIntoTaskPatch(doc, context)).toMatchObject({
			title: "Call the dentist",
			due: "2025-09-10",
			status: "none",
			priority: "high",
			tags: ["health", "calls"],
		});
	});

	it("signals cleared fields with null rather than omitting them", () => {
		const doc = parseVTodoDocument(
			["BEGIN:VCALENDAR", "BEGIN:VTODO", "UID:abc", "END:VTODO", "END:VCALENDAR"].join(
				"\r\n"
			)
		)!;
		const patch = readVTodoIntoTaskPatch(doc, context);

		expect(patch.due).toBeNull();
		expect(patch.scheduled).toBeNull();
		expect(patch.completedDate).toBeNull();
		expect(patch.recurrence).toBeNull();
	});

	it("survives a full task -> VTODO -> task round trip", () => {
		const doc = createVTodoDocument();
		const task = makeTask({
			title: "Round trip",
			status: "done",
			priority: "high",
			due: "2025-09-03",
			scheduled: "2025-09-01",
			completedDate: "2025-09-02",
			tags: ["a", "b"],
		});
		applyTaskToVTodo(doc, task, context, { uid: "u" });

		const reparsed = parseVTodoDocument(serializeVTodoDocument(doc))!;
		expect(readVTodoIntoTaskPatch(reparsed, context)).toMatchObject({
			title: "Round trip",
			status: "done",
			priority: "high",
			due: "2025-09-03",
			scheduled: "2025-09-01",
			completedDate: "2025-09-02",
			tags: ["a", "b"],
		});
	});

	it("reads the UID", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask(), context, { uid: "the-uid" });
		expect(readVTodoUid(doc)).toBe("the-uid");
	});
});

describe("readVTodoRevision", () => {
	function docWith(lines: string[]) {
		return parseVTodoDocument(
			["BEGIN:VCALENDAR", "BEGIN:VTODO", "UID:x", ...lines, "END:VTODO", "END:VCALENDAR"].join(
				"\r\n"
			)
		)!;
	}

	it("prefers LAST-MODIFIED over DTSTAMP", () => {
		const doc = docWith(["DTSTAMP:20250901T120000Z", "LAST-MODIFIED:20250901T130000Z"]);
		expect(readVTodoRevision(doc)).toBe(Date.UTC(2025, 8, 1, 13, 0, 0));
	});

	it("falls back to DTSTAMP, which RFC 5545 defines as the last revision for stored objects", () => {
		expect(readVTodoRevision(docWith(["DTSTAMP:20250901T120000Z"]))).toBe(
			Date.UTC(2025, 8, 1, 12, 0, 0)
		);
	});

	it("returns null when neither is present, so the caller can fall back", () => {
		expect(readVTodoRevision(docWith([]))).toBeNull();
	});
});

describe("mergeRemoteTags", () => {
	it("takes the server's categories and keeps a protected tag the note had", () => {
		expect(mergeRemoteTags(["errands"], ["task", "old"], ["task"])).toEqual(["errands", "task"]);
	});

	it("keeps the protected tag when a client dropped every category", () => {
		// Otherwise a phone that strips categories would turn the note into a non-task.
		expect(mergeRemoteTags([], ["task", "errands"], ["task"])).toEqual(["task"]);
	});

	it("does not duplicate a protected tag the server also sent", () => {
		expect(mergeRemoteTags(["task", "errands"], ["task"], ["task"])).toEqual(["task", "errands"]);
	});

	it("does not invent a protected tag the note never had", () => {
		expect(mergeRemoteTags(["errands"], ["old"], ["task"])).toEqual(["errands"]);
	});

	it("adds the protected tag to an import when passed as the local tags", () => {
		expect(mergeRemoteTags(["errands"], ["task"], ["task"])).toEqual(["errands", "task"]);
	});
});

describe("reconcileStartAndDue (RFC 5545: same value type, DUE not before DTSTART)", () => {
	const date = (value: string) => ({ dateOnly: true, value, utc: false });
	const utc = (value: string) => ({ dateOnly: false, value, utc: true });

	it("promotes a date-only start to the beginning of its day when due has a time", () => {
		expect(reconcileStartAndDue(date("2026-03-25"), utc("2026-03-25T23:59:00"), false)).toEqual({
			start: utc("2026-03-25T00:00:00"),
			due: utc("2026-03-25T23:59:00"),
		});
	});

	it("promotes a date-only due to the end of its day when start has a time", () => {
		expect(reconcileStartAndDue(utc("2026-03-13T10:30:00"), date("2026-03-16"), false)).toEqual({
			start: utc("2026-03-13T10:30:00"),
			due: utc("2026-03-16T23:59:00"),
		});
	});

	it("drops the start when due comes before it", () => {
		expect(reconcileStartAndDue(date("2026-05-11"), date("2026-05-08"), false)).toEqual({
			start: null,
			due: date("2026-05-08"),
		});
	});

	it("keeps the start and drops due instead when a recurrence rule needs the anchor", () => {
		expect(reconcileStartAndDue(date("2026-05-11"), date("2026-05-08"), true)).toEqual({
			start: date("2026-05-11"),
			due: null,
		});
	});

	it("leaves valid and single-sided pairs alone", () => {
		expect(reconcileStartAndDue(date("2026-05-08"), date("2026-05-08"), false)).toEqual({
			start: date("2026-05-08"),
			due: date("2026-05-08"),
		});
		expect(reconcileStartAndDue(null, utc("2026-05-08T10:00:00"), false)).toEqual({
			start: null,
			due: utc("2026-05-08T10:00:00"),
		});
	});

	it("is applied by applyTaskToVTodo, so the VTODO carries matching types", () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, makeTask({ scheduled: "2026-03-25", due: "2026-03-25T23:59" }), context, {
			uid: "uid-1",
		});
		expect(getProperty(doc, "DTSTART")).toMatchObject({ value: "20260325T000000Z" });
		expect(getProperty(doc, "DUE")).toMatchObject({ value: "20260325T235900Z" });
	});
});

describe("changedFields", () => {
	it("drops fields equal to the plugin's own encoding and keeps real changes", () => {
		expect(
			changedFields(
				{ title: "New", status: "open", due: null, tags: ["B", "a"] },
				{ title: "Old", status: "open", tags: ["a", "b"] }
			)
		).toEqual({ title: "New" });
	});

	it("treats a cleared value as a change when the note had one", () => {
		expect(changedFields({ due: null }, { due: "2026-05-08" })).toEqual({ due: null });
	});
});

describe("pull round trip", () => {
	const local = makeTask({
		status: "in-progress",
		priority: "normal",
		scheduled: "2026-03-25",
		due: "2026-03-25T23:59",
		tags: ["errands"],
	});
	const encode = () => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, local, context, { uid: "uid-1" });
		return doc;
	};
	const own = readVTodoIntoTaskPatch(encode(), context);

	it("changes nothing when the server kept what it was sent", () => {
		// Without this, the promoted 00:00 start and the in-progress status (sent
		// as NEEDS-ACTION) would both be rewritten into the note on every pull.
		expect(changedFields(readVTodoIntoTaskPatch(encode(), context), own)).toEqual({});
	});

	it("applies only what the server changed", () => {
		const remote = encode();
		setTextProperty(remote, "SUMMARY", "Edited on the phone");
		expect(changedFields(readVTodoIntoTaskPatch(remote, context), own)).toEqual({
			title: "Edited on the phone",
		});
	});
});

describe("projects", () => {
	const task = makeTask({ title: "Fix the roof" });
	const encode = (projects?: string[]) => {
		const doc = createVTodoDocument();
		applyTaskToVTodo(doc, task, context, { uid: "u", projects });
		return doc;
	};

	it("prefixes the title with the first project and lists every project", () => {
		const doc = encode(["House", "Garden, front"]);
		expect(getTextProperty(doc, "SUMMARY")).toBe("House | Fix the roof");
		expect(getProperty(doc, "X-TASKNOTES-PROJECTS")?.value).toBe("House,Garden\\, front");
	});

	it("drops prefix and property once the task has no project", () => {
		const doc = encode(["House"]);
		applyTaskToVTodo(doc, task, context, { uid: "u", projects: [] });
		expect(getTextProperty(doc, "SUMMARY")).toBe("Fix the roof");
		expect(getProperty(doc, "X-TASKNOTES-PROJECTS")).toBeUndefined();
	});

	it("strips the prefix it wrote, even one edited on a phone, but not a title typed with a pipe", () => {
		const doc = encode(["House"]);
		expect(readVTodoIntoTaskPatch(doc, context).title).toBe("Fix the roof");
		setTextProperty(doc, "SUMMARY", "Garden | Fix the roof");
		expect(readVTodoIntoTaskPatch(doc, context).title).toBe("Fix the roof");
		const typed = encode();
		setTextProperty(typed, "SUMMARY", "Haus | Dach");
		expect(readVTodoIntoTaskPatch(typed, context).title).toBe("Haus | Dach");
	});

	it("reads back as an unchanged title", () => {
		const own = readVTodoIntoTaskPatch(encode(), context);
		expect(changedFields(readVTodoIntoTaskPatch(encode(["House"]), context), own)).toEqual({});
	});

	it("splits a prefix at the first separator only", () => {
		expect(parseProjectPrefix("House | Fix the roof")).toEqual({ project: "House", title: "Fix the roof" });
		expect(parseProjectPrefix("House | a | b")).toEqual({ project: "House", title: "a | b" });
		expect(parseProjectPrefix("Fix the roof")).toBeUndefined();
		expect(parseProjectPrefix("a|b")).toBeUndefined();
		expect(parseProjectPrefix(" | Fix")).toBeUndefined();
		expect(parseProjectPrefix("House | ")).toBeUndefined();
	});

	it("spots a missing prefix or outdated project names", () => {
		expect(hasStaleProjects(encode(["House"]), ["House"])).toBe(false);
		expect(hasStaleProjects(encode(), [])).toBe(false);
		expect(hasStaleProjects(encode(), ["House"])).toBe(true);
		expect(hasStaleProjects(encode(["House"]), [])).toBe(true);
		expect(hasStaleProjects(encode(["House"]), ["House", "Garden"])).toBe(true);
		const edited = encode(["House"]);
		setTextProperty(edited, "SUMMARY", "Fix the roof");
		expect(hasStaleProjects(edited, ["House"])).toBe(true);
	});
});
