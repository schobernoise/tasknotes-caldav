/**
 * TaskInfo <-> VTODO field mapping.
 *
 * Statuses and priorities in TaskNotes are user-defined strings, while VTODO
 * has four fixed STATUS values and a 1-9 PRIORITY scale, so both directions go
 * through the user's configured `StatusConfig` / `PriorityConfig` lists rather
 * than any hard-coded vocabulary.
 *
 * Fields deliberately NOT mapped, and preserved verbatim instead (see
 * vtodoDocument.ts): DESCRIPTION (the note body is not synced), VALARM,
 * RELATED-TO, ATTACH and every X- property.
 *
 * Pure: no Obsidian runtime, no network, no DOM or timer globals.
 */

import type { PriorityConfig, StatusConfig, TaskInfo } from "../tasknotes";
import {
	type IcsDateValue,
	formatIcsDateValue,
	icsDateValueToTaskDate,
	icsStampToEpochMs,
	isoToIcsUtcStamp,
	parseIcsDateValue,
	taskDateToIcsDateValue,
	type ZoneToUtc,
} from "./icsDateValue";
import {
	getProperty,
	getTextListProperty,
	getTextProperty,
	removeProperty,
	setProperty,
	setTextListProperty,
	setTextProperty,
	type VTodoDocument,
} from "./vtodoDocument";

export const VTODO_STATUSES = [
	"NEEDS-ACTION",
	"IN-PROCESS",
	"COMPLETED",
	"CANCELLED",
] as const;

export type VTodoStatus = (typeof VTODO_STATUSES)[number];

export interface VTodoMappingContext {
	statuses: StatusConfig[];
	priorities: PriorityConfig[];
	/** Per-status overrides of the auto-derived VTODO status. */
	statusOverrides?: Record<string, VTodoStatus>;
	/** Resolves a TZID wall time to UTC; see icsDateValue.ts. */
	zoneToUtc?: ZoneToUtc;
	/** Tags kept out of CATEGORIES, e.g. the tag TaskNotes identifies task notes by. */
	hiddenTags?: readonly string[];
	/** The user's PRIORITY (0-9) per TaskNotes priority, over the defaults. */
	priorityMap?: Readonly<Record<string, number>>;
}

/** The subset of a task that a remote VTODO can dictate. */
export interface VTodoTaskPatch {
	title?: string;
	status?: string;
	priority?: string;
	due?: string | null;
	scheduled?: string | null;
	completedDate?: string | null;
	tags?: string[];
	recurrence?: string | null;
}

export function isVTodoStatus(value: string): value is VTodoStatus {
	return (VTODO_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Derives a VTODO status from the flags `StatusConfig` already carries, unless
 * the user has pinned an explicit override for this status value.
 */
export function taskStatusToVTodo(
	statusValue: string,
	context: VTodoMappingContext
): VTodoStatus {
	const override = context.statusOverrides?.[statusValue];
	if (override && isVTodoStatus(override)) return override;

	const config = findStatus(context.statuses, statusValue);
	if (config?.isCompleted) return "COMPLETED";
	if (config?.isSkipped) return "CANCELLED";
	return "NEEDS-ACTION";
}

/**
 * Picks the TaskNotes status that best represents a remote VTODO status.
 *
 * An explicit override wins, so a user who mapped "in-progress" to IN-PROCESS
 * gets that same status back rather than a generic open one.
 */
export function vTodoStatusToTaskStatus(
	vtodoStatus: string,
	context: VTodoMappingContext
): string | undefined {
	const normalized = vtodoStatus?.trim().toUpperCase();
	if (!normalized) return undefined;

	const override = Object.entries(context.statusOverrides ?? {}).find(
		([, mapped]) => mapped === normalized
	)?.[0];
	if (override && findStatus(context.statuses, override)) return override;

	const ordered = [...context.statuses].sort((a, b) => a.order - b.order);
	const open = ordered.filter((status) => !status.isCompleted && !status.isSkipped);

	switch (normalized) {
		case "COMPLETED":
			return ordered.find((status) => status.isCompleted)?.value;
		case "CANCELLED":
			return (
				ordered.find((status) => status.isSkipped)?.value ??
				ordered.find((status) => status.isCompleted)?.value
			);
		case "IN-PROCESS":
			// Without an override there is no way to distinguish in-progress from
			// not-started, so prefer a second open status when one exists.
			return (open[1] ?? open[0] ?? ordered[0])?.value;
		case "NEEDS-ACTION":
			return (open[0] ?? ordered[0])?.value;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Default PRIORITY per TaskNotes priority, anchored on the three bands clients
 * such as Nextcloud Tasks and Apple Reminders display (RFC 5545 §3.8.1.9,
 * https://www.rfc-editor.org/rfc/rfc5545#section-3.8.1.9): 1-4 high, 5 medium,
 * 6-9 low. The lowest weight is low (9), the next is medium (5), the rest share
 * 1-4. A zero-or-negative weight is "none", which RFC 5545 spells as 0.
 */
export function defaultPriorityScale(priorities: readonly PriorityConfig[]): Map<string, number> {
	const scale = new Map<string, number>();
	for (const priority of priorities) if (priority.weight <= 0) scale.set(priority.value, 0);

	const weighted = priorities.filter((priority) => priority.weight > 0).sort((a, b) => b.weight - a.weight);
	const [low, medium] = [...weighted].reverse();
	const high = weighted.slice(0, Math.max(0, weighted.length - 2));
	high.forEach((priority, index) =>
		scale.set(priority.value, high.length === 1 ? 1 : Math.round(1 + (index * 3) / (high.length - 1)))
	);
	if (medium) scale.set(medium.value, 5);
	if (low) scale.set(low.value, medium ? 9 : 5);
	return scale;
}

/** The default scale with the user's per-priority choices applied. */
export function priorityScale(
	priorities: readonly PriorityConfig[],
	overrides: Readonly<Record<string, number>> = {}
): Map<string, number> {
	const scale = defaultPriorityScale(priorities);
	for (const [value, chosen] of Object.entries(overrides)) {
		if (scale.has(value) && isPriorityNumber(chosen)) scale.set(value, chosen);
	}
	return scale;
}

/** The PRIORITY to write, or undefined to write none. */
export function taskPriorityToVTodo(
	priorityValue: string,
	context: VTodoMappingContext
): number | undefined {
	const mapped = priorityScale(context.priorities, context.priorityMap).get(priorityValue);
	return mapped ? mapped : undefined;
}

/**
 * The TaskNotes priority for a PRIORITY value; `undefined` means the property
 * is absent, which RFC 5545 treats like 0. An exact match wins, then the
 * nearest priority in the same band, then the nearest overall; ties go to the
 * higher weight. Garbage yields undefined, so the note keeps its priority.
 */
export function vTodoPriorityToTaskPriority(
	priority: number | undefined,
	context: VTodoMappingContext
): string | undefined {
	const scale = priorityScale(context.priorities, context.priorityMap);
	const byWeight = [...context.priorities].sort((a, b) => b.weight - a.weight);
	const entries = byWeight.map((config) => ({ value: config.value, mapped: scale.get(config.value) ?? 0 }));

	if (priority === undefined || priority === 0) {
		return entries.filter((entry) => entry.mapped === 0).pop()?.value;
	}
	if (!isPriorityNumber(priority)) return undefined;

	const set = entries.filter((entry) => entry.mapped > 0);
	const sameBand = set.filter((entry) => priorityBand(entry.mapped) === priorityBand(priority));
	return nearest(sameBand, priority) ?? nearest(set, priority);
}

/**
 * True when the server holds a PRIORITY other than the one the current scale
 * gives this task, as after the user changed the scale.
 */
export function hasStalePriority(doc: VTodoDocument, task: TaskInfo, context: VTodoMappingContext): boolean {
	const raw = getProperty(doc, "PRIORITY")?.value;
	const onServer = raw === undefined ? 0 : Number.parseInt(raw, 10);
	return onServer !== (taskPriorityToVTodo(task.priority, context) ?? 0);
}

function nearest(entries: readonly { value: string; mapped: number }[], priority: number): string | undefined {
	let best: { value: string; distance: number } | undefined;
	for (const { value, mapped } of entries) {
		const distance = Math.abs(mapped - priority);
		if (!best || distance < best.distance) best = { value, distance };
	}
	return best?.value;
}

function priorityBand(priority: number): "high" | "medium" | "low" {
	return priority <= 4 ? "high" : priority === 5 ? "medium" : "low";
}

function isPriorityNumber(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 9;
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/**
 * TaskNotes stores recurrence as an RRULE with an embedded DTSTART
 * ("DTSTART:20240115;FREQ=WEEKLY"), whereas iCalendar carries DTSTART as its
 * own property. These two helpers move between the forms.
 */
export function splitRecurrence(recurrence: string): {
	dtstart?: string;
	rule: string;
} {
	const match = /DTSTART:(\d{8})(T\d{6}Z?)?;?/u.exec(recurrence);
	if (!match) return { rule: recurrence.replace(/^RRULE:/u, "").trim() };

	const rule = recurrence.replace(match[0], "").replace(/^RRULE:/u, "").trim();
	return { dtstart: `${match[1]}${match[2] ?? ""}`, rule };
}

export function joinRecurrence(dtstartCompact: string | undefined, rule: string): string {
	const cleaned = rule.replace(/^RRULE:/u, "").trim();
	if (!cleaned) return "";
	return dtstartCompact ? `DTSTART:${dtstartCompact};${cleaned}` : cleaned;
}

// ---------------------------------------------------------------------------
// Task -> VTODO
// ---------------------------------------------------------------------------

/**
 * Patches the fields TaskNotes owns onto an existing VTODO, leaving every other
 * line — including VALARM blocks and X- properties — untouched.
 */
export function applyTaskToVTodo(
	doc: VTodoDocument,
	task: TaskInfo,
	context: VTodoMappingContext,
	options: { uid: string; now?: string }
): void {
	const now = options.now ?? new Date().toISOString();

	setTextProperty(doc, "UID", options.uid);
	setTextProperty(doc, "SUMMARY", task.title ?? "");

	const recurrence = task.recurrence ? splitRecurrence(task.recurrence) : undefined;
	// DTSTART doubles as the recurrence anchor, so a recurring task falls back to
	// the rule's own anchor when it has no scheduled date of its own.
	const { start, due } = reconcileStartAndDue(
		task.scheduled
			? taskDateToIcsDateValue(task.scheduled)
			: recurrence?.dtstart
				? parseIcsDateValue(recurrence.dtstart)
				: null,
		task.due ? taskDateToIcsDateValue(task.due) : null,
		Boolean(recurrence?.rule)
	);
	writeDate(doc, "DTSTART", start);
	writeDate(doc, "DUE", due);

	if (recurrence?.rule) {
		setProperty(doc, "RRULE", recurrence.rule);
	} else {
		removeProperty(doc, "RRULE");
	}

	const status = taskStatusToVTodo(task.status, context);
	setProperty(doc, "STATUS", status);

	if (status === "COMPLETED") {
		const completed = task.completedDate
			? taskDateToIcsDateValue(task.completedDate)
			: null;
		// COMPLETED must be a UTC date-time per RFC 5545, so a date-only
		// completion is anchored at midnight rather than emitted as a DATE.
		const stamp = completed
			? completed.dateOnly
				? `${completed.value.replace(/-/gu, "")}T000000Z`
				: formatIcsDateValue(completed).value
			: isoToIcsUtcStamp(now);
		if (stamp) setProperty(doc, "COMPLETED", stamp);
		setProperty(doc, "PERCENT-COMPLETE", "100");
	} else {
		removeProperty(doc, "COMPLETED");
		removeProperty(doc, "PERCENT-COMPLETE");
	}

	const priority = taskPriorityToVTodo(task.priority, context);
	if (priority === undefined) removeProperty(doc, "PRIORITY");
	else setProperty(doc, "PRIORITY", String(priority));

	setTextListProperty(
		doc,
		"CATEGORIES",
		(task.tags ?? []).filter((tag) => !includesTag(context.hiddenTags ?? [], tag))
	);

	const stamp = isoToIcsUtcStamp(now);
	if (stamp) {
		setProperty(doc, "DTSTAMP", stamp);
		setProperty(doc, "LAST-MODIFIED", stamp);
	}
	bumpSequence(doc);
}

function writeDate(doc: VTodoDocument, name: string, date: IcsDateValue | null): void {
	if (!date) {
		removeProperty(doc, name);
		return;
	}
	const { value, params } = formatIcsDateValue(date);
	setProperty(doc, name, value, params);
}

/**
 * Makes a task's start/due pair valid for a VTODO.
 *
 * RFC 5545 §3.6.2 requires DUE and DTSTART to share a value type and DUE not to
 * precede DTSTART; TaskNotes allows both, and servers such as Nextcloud reject
 * the resource outright (415). A mixed pair gets its date-only side promoted:
 * the start to the beginning of its day, the due date to the end of its day,
 * so no information is lost. An inverted pair drops the start, unless a
 * recurrence rule needs it as its anchor, in which case the due date goes.
 * Pulls leave the note alone as long as the server keeps these values; see
 * changedFields.
 */
export function reconcileStartAndDue(
	start: IcsDateValue | null,
	due: IcsDateValue | null,
	hasRecurrenceRule: boolean
): { start: IcsDateValue | null; due: IcsDateValue | null } {
	if (!start || !due) return { start, due };

	if (start.dateOnly !== due.dateOnly) {
		if (start.dateOnly) start = taskDateToIcsDateValue(`${start.value}T00:00`);
		else due = taskDateToIcsDateValue(`${due.value}T23:59`);
	}

	if (start && due && isBefore(due, start)) {
		return hasRecurrenceRule ? { start, due: null } : { start: null, due };
	}
	return { start, due };
}

/** Values compare as strings only in the same form: both dates, or both UTC. */
function isBefore(a: IcsDateValue, b: IcsDateValue): boolean {
	const sameForm = a.dateOnly ? b.dateOnly : a.utc && b.utc;
	return sameForm && a.value < b.value;
}

function bumpSequence(doc: VTodoDocument): void {
	const current = Number.parseInt(getProperty(doc, "SEQUENCE")?.value ?? "0", 10);
	setProperty(doc, "SEQUENCE", String(Number.isFinite(current) ? current + 1 : 1));
}

// ---------------------------------------------------------------------------
// VTODO -> Task
// ---------------------------------------------------------------------------

export function readVTodoUid(doc: VTodoDocument): string | undefined {
	return getTextProperty(doc, "UID")?.trim() || undefined;
}

/**
 * Epoch milliseconds of the remote's last revision, for the conflict tiebreak.
 *
 * LAST-MODIFIED is preferred where present; RFC 5545 gives DTSTAMP the same
 * meaning for an object held in a calendar store (one with no METHOD property),
 * which is exactly the CalDAV case.
 */
export function readVTodoRevision(doc: VTodoDocument): number | null {
	return (
		icsStampToEpochMs(getProperty(doc, "LAST-MODIFIED")?.value) ??
		icsStampToEpochMs(getProperty(doc, "DTSTAMP")?.value)
	);
}

export function readVTodoIntoTaskPatch(
	doc: VTodoDocument,
	context: VTodoMappingContext
): VTodoTaskPatch {
	const patch: VTodoTaskPatch = {};

	const summary = getTextProperty(doc, "SUMMARY");
	if (summary !== undefined) patch.title = summary;

	patch.due = readDate(doc, "DUE", context) ?? null;

	const dtstart = readDate(doc, "DTSTART", context);
	patch.scheduled = dtstart ?? null;

	const statusProperty = getProperty(doc, "STATUS")?.value;
	const status = statusProperty
		? vTodoStatusToTaskStatus(statusProperty, context)
		: undefined;
	if (status) patch.status = status;

	const completed = readDate(doc, "COMPLETED", context);
	patch.completedDate = completed ? completed.slice(0, 10) : null;

	const priorityRaw = getProperty(doc, "PRIORITY")?.value;
	const priority = vTodoPriorityToTaskPriority(
		priorityRaw === undefined ? undefined : Number.parseInt(priorityRaw, 10),
		context
	);
	if (priority) patch.priority = priority;

	patch.tags = getTextListProperty(doc, "CATEGORIES");

	const rrule = getProperty(doc, "RRULE")?.value?.trim();
	if (rrule) {
		const anchor = getProperty(doc, "DTSTART");
		const anchorValue = anchor
			? parseIcsDateValue(anchor.value, anchor.params)
			: null;
		const compact = anchorValue ? formatIcsDateValue(anchorValue).value : undefined;
		patch.recurrence = joinRecurrence(compact, rrule);
	} else {
		patch.recurrence = null;
	}

	return patch;
}

function readDate(
	doc: VTodoDocument,
	name: string,
	context: VTodoMappingContext
): string | undefined {
	const property = getProperty(doc, name);
	if (!property) return undefined;

	const parsed = parseIcsDateValue(property.value, property.params);
	if (!parsed) return undefined;

	return icsDateValueToTaskDate(parsed, context.zoneToUtc) ?? undefined;
}

/**
 * The fields of a pulled VTODO that the server actually changed.
 *
 * `own` is what reading back the plugin's own encoding of the local task gives.
 * Where the server's value equals it, the server kept what it was sent, and
 * the note keeps its own value: otherwise lossy encodings would leak back into
 * it on every pull (a date promoted to a time for RFC 5545, an in-progress
 * status sent as NEEDS-ACTION, a priority rounded onto the 1-9 scale).
 */
export function changedFields(remote: VTodoTaskPatch, own: VTodoTaskPatch): VTodoTaskPatch {
	const changed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(remote)) {
		if (comparableValue(value) !== comparableValue(own[key as keyof VTodoTaskPatch])) {
			changed[key] = value;
		}
	}
	return changed as VTodoTaskPatch;
}

function comparableValue(value: unknown): string {
	if (value === undefined || value === null || value === "") return "";
	if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item).toLowerCase()).sort());
	return JSON.stringify(value);
}

/**
 * The tags a task should carry after a pull: the server's CATEGORIES plus any
 * protected tag the note already had. A client that drops or never saw the
 * TaskNotes task tag must not be able to strip it, or the note would stop
 * being a task.
 */
export function mergeRemoteTags(
	remoteTags: readonly string[],
	localTags: readonly string[] | undefined,
	protectedTags: readonly string[]
): string[] {
	const kept = (localTags ?? []).filter(
		(tag) => includesTag(protectedTags, tag) && !includesTag(remoteTags, tag)
	);
	return [...remoteTags, ...kept];
}

function includesTag(tags: readonly string[], tag: string): boolean {
	const wanted = normalizeTag(tag);
	return tags.some((candidate) => normalizeTag(candidate) === wanted);
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#/u, "").toLowerCase();
}

function findStatus(statuses: StatusConfig[], value: string): StatusConfig | undefined {
	return statuses.find((status) => status.value === value);
}
