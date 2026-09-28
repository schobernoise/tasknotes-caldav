# TaskNotes CalDAV

Keep your [TaskNotes](https://github.com/callumalpass/tasknotes) tasks in sync with a CalDAV task list — Nextcloud Tasks, Apple Reminders, Radicale, Baikal, anything that stores VTODOs. Create a task in Obsidian and it shows up on your phone a couple of seconds later. Tick it off on the phone and the note updates on the next sync.

This is a companion plugin: it does nothing on its own and needs TaskNotes installed and enabled. Your tasks stay ordinary Markdown notes; the plugin only adds a few `caldav_*` keys to their frontmatter.

## Why a separate plugin

The sync started life as a pull request to TaskNotes itself ([#2280](https://github.com/callumalpass/tasknotes/pull/2280)). TaskNotes has since grown an official runtime API for companion plugins, so the same mechanism now lives here and talks to TaskNotes only through that API. It works with stock TaskNotes and doesn't have to wait on a merge.

## Requirements

- Obsidian 1.11.4 or newer. Passwords go into Obsidian's secret storage, which older versions don't have.
- TaskNotes with runtime API v1 (tested with TaskNotes 4.13.6). The plugin checks the API version and the capabilities it needs at startup, and tells you with a notice if something is missing.
- Tested on desktop against Nextcloud. The plugin isn't marked desktop-only, but it hasn't been tried on mobile yet.

## Installation

The plugin is not in the community plugin directory (yet). Two ways to install it:

- **BRAT**: add `schobernoise/tasknotes-caldav` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/schobernoise/tasknotes-caldav/releases/latest) into `<vault>/.obsidian/plugins/tasknotes-caldav/`, then enable *TaskNotes CalDAV* under Settings → Community plugins.

## Setup

1. Settings → TaskNotes CalDAV → **Add account**.
2. Fill in **Server URL**, **Username** and **Password**. Any address on the server works; the plugin walks up to the account root on its own.
   - Nextcloud: `https://cloud.example.com/remote.php/dav`
   - iCloud: `https://caldav.icloud.com` with an app-specific password
   - Credentials are only ever sent over `https://` (plain `http://` is allowed for `localhost`).
3. Press **Discover** and pick the task list. Event-only calendars, read-only subscriptions and deleted lists are filtered out.
4. Optionally narrow down what the account syncs: a **tag filter** (only tasks with any of the listed tags, or all tasks except those) and/or a **folder**.
5. Press **Preview** under *First sync*. You get four numbers — to upload, to import, already matching, changed on both sides — and nothing is written until you confirm.
6. Turn on **Sync this account**.

Two commands are available from the command palette: **Sync tasks with CalDAV now** and **Unlink all tasks from CalDAV**.

## What syncs

| TaskNotes | CalDAV (VTODO) |
|---|---|
| Title | `SUMMARY` |
| Due / scheduled date | `DUE` / `DTSTART` |
| Status | `STATUS` |
| Priority | `PRIORITY` |
| Completed date | `COMPLETED` |
| Tags | `CATEGORIES` |
| Recurrence | `RRULE` |
| Projects (parent tasks) | `RELATED-TO;RELTYPE=PARENT` |
| Blocked by | `RELATED-TO` with the dependency type (RFC 9253) |
| Reminders | `VALARM` |

The note body is **not** synced. Anything the plugin doesn't model — a description written on the phone, attachments, custom `X-` properties — is left exactly as it was on the server.

**Statuses and priorities.** TaskNotes lets you define your own, CalDAV has a fixed set. A status marked *completed* becomes `COMPLETED`, one marked *skipped* becomes `CANCELLED`, everything else `NEEDS-ACTION`. Coming back, `NEEDS-ACTION` maps to your first open status by order. Priorities are spread across CalDAV's 1–9 scale by their weight.

**The task tag.** TaskNotes recognises task notes by a tag (`#task` by default). Every synced task would carry it, so it's left off the server unless you turn on *Sync the task tag*. Your notes always keep it, even when a phone app edits or drops a task's categories.

**Subtasks.** A subtask is a task whose *Projects* field links to another task, and it arrives on the server as a real subtask. A link is only sent once both tasks exist on the server; projects that are plain notes rather than tasks are left out.

## How it behaves

- **Timing.** Local edits are pushed about 1.5 seconds after you stop typing, whether you edit through TaskNotes or type straight into the frontmatter. Server changes are polled per account (every 15 minutes by default), and a poll that finds the list unchanged stops after a single request.
- **Conflicts.** If both sides changed since the last sync, the server rejects the write (ETag mismatch) and the more recently changed side wins. This compares your computer's clock with the server's, so both should be roughly right.
- **Deleting.** Deleting a note deletes the task on the server. When a task disappears from the server you choose per account: archive the note (default), keep it and stop syncing, or delete it.
- **Archived tasks** are never uploaded.
- **Scoping.** A task syncs to the first enabled account whose tag filter and folder it matches, so it's never uploaded twice. Nested tags count: a filter on `work` also matches `work/client`.
- **Offline.** A push that fails is queued and retried every minute, up to five attempts.
- **Unlinking** removes the `caldav_*` keys and deletes nothing on either side. The link is also what stops a task being uploaded twice, so syncing the same list again afterwards gives you a second copy of every task.

## Known limitations

- If TaskNotes stores titles in filenames (its default), characters that can't go in a filename, like `:`, are dropped from titles pulled in from the server. The server keeps its version; the plugin doesn't push the shortened title back.
- An `IN-PROCESS` status from the server can't be told apart from "not started" unless your statuses make it obvious. The plugin picks your second open status.
- If you disable TaskNotes while this plugin is running, sync stops. Reload this plugin after re-enabling TaskNotes.

## Privacy

Your password lives in Obsidian's secret storage and is never written to `data.json`. Task UIDs are random, so vault paths are never visible to anyone else who can see the list. The plugin talks to the servers you configure and nothing else.

## Development

```bash
npm install
npm run dev     # esbuild watch, writes main.js
npm run build   # typecheck + production bundle
npm test        # unit tests for the pure CalDAV modules (Jest, jsdom)
```

```
src/main.ts               lifecycle: connect to TaskNotes, wire events and commands
src/tasknotes.ts          the slice of the TaskNotes runtime API used, plus the version/capability check
src/CalDavSyncService.ts  push, pull, conflicts, relations, retry queue
src/SettingsTab.ts        account settings UI
src/settings.ts           settings types and defaults
src/caldav/               pure modules: CalDAV client, XML, ICS dates, VTODO mapping, reconciliation
tests/caldav/             unit tests for src/caldav/
```

The pure modules in `src/caldav/` hold every sync decision (what a VTODO looks like, who wins a conflict, what to upload) and do no I/O, which is why they're the part with unit tests. `CalDavSyncService` carries out those decisions: vault writes, timers, network.

### Releasing

```bash
npm version patch   # or minor / major: runs tests + build, bumps manifest.json and versions.json, commits, tags
npm run release     # pushes main and the tag to origin, Codeberg and GitHub
```

Pushing the tag triggers CI on GitHub and Codeberg, which builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a release. Tags carry no `v` prefix, because Obsidian looks releases up by the exact version in `manifest.json`.

## Credits

Built on [TaskNotes](https://github.com/callumalpass/tasknotes) by Callum Alpass and its runtime API. MIT licensed, see [LICENSE](LICENSE).
