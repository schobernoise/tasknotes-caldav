# TaskNotes CalDAV

Two-way sync between [TaskNotes](https://github.com/callumalpass/tasknotes) tasks and a CalDAV task list (VTODO): Nextcloud Tasks, Apple Reminders, Radicale, Baikal.

A companion plugin: it talks to TaskNotes only through its [runtime API](https://github.com/callumalpass/tasknotes/blob/main/docs/javascript-api.md) (`app.plugins.getPlugin("tasknotes").api`, v1). The sync mechanism is ported from [tasknotes#2280](https://github.com/callumalpass/tasknotes/pull/2280).

## Requirements

- TaskNotes enabled (runtime API v1). Without it the plugin shows a notice and does nothing.
- Obsidian 1.11.4+ (passwords live in Obsidian's secret storage, never in `data.json`).

## Setup

Settings → TaskNotes CalDAV → **Add account**, fill in server URL, username, password, press **Discover**, pick the list, run **First sync → Preview**, then turn on **Sync this account**. Optionally restrict an account to a tag and/or folder.

Commands: *Sync tasks with CalDAV now*, *Unlink all tasks from CalDAV*.

## What syncs

| TaskNotes | VTODO |
|---|---|
| title, due, scheduled | `SUMMARY`, `DUE`, `DTSTART` |
| status, priority, completed date | `STATUS`, `PRIORITY`, `COMPLETED` |
| tags, recurrence | `CATEGORIES`, `RRULE` |
| projects (parent), blocked by | `RELATED-TO` |
| reminders | `VALARM` |

The note body is not synced; remote properties the plugin does not model (e.g. `DESCRIPTION`) are preserved. Sync links live in the note's `caldav_*` frontmatter keys; bookkeeping (fingerprints, resource index, retry queue) lives in this plugin's `data.json`.

## Layout

```
src/main.ts               plugin lifecycle: connect to TaskNotes, wire events and commands
src/tasknotes.ts          the TaskNotes runtime-API subset used, plus the version/capability check
src/CalDavSyncService.ts  orchestration: push, pull, conflicts, relations, retry queue
src/SettingsTab.ts        account UI
src/settings.ts           settings types and defaults
src/caldav/               pure modules: CalDAV client, XML, ICS dates, VTODO mapping, reconciliation
tests/caldav/             unit tests for src/caldav/
```

## Development

```bash
npm install
npm run build   # tsc --noEmit + esbuild → main.js
npm test        # jest (jsdom)
npm run dev     # esbuild watch
```
