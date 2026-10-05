# TaskNotes CalDAV

Keep your [TaskNotes](https://github.com/callumalpass/tasknotes) tasks in sync with CalDAV task lists — Nextcloud Tasks, Apple Reminders, Radicale, Baikal, anything that stores VTODOs. Create a task in Obsidian and it shows up on your phone a couple of seconds later. Tick it off on the phone and the note updates on the next sync. Tags and projects decide which list a task lands in: `#work` to your Work list, everything that belongs to a project to a project list, everything else to a default list.

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
3. Under **Task lists**, press **Discover**. Event-only calendars, read-only subscriptions and deleted lists are filtered out.
4. Route lists: pick a list under **Route another list** and give it tags. Under **Everything else**, choose the list for tasks that match none of them, or *Don't sync*. Under **Project tasks**, choose the list for tasks that belong to a project, or leave them routed by tags. See [Task lists, tags and projects](#task-lists-tags-and-projects).
5. Optionally keep tasks out: **Never sync** tags, **Never sync project tasks**, **Only tasks in folders** and **Never sync tasks in folders**. Subfolders count, and a task in a never-sync folder stays out even inside an only-these folder.
6. Turn on **Sync this account**, then press **Preview first sync**. For each new list you get the numbers — to upload, to import, already matching, changed on both sides, moving in from other lists — and nothing is written until you confirm. A list only starts syncing after its first sync.

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
| Projects (project notes) | `X-TASKNOTES-PROJECTS`, and the first one as a title prefix |
| Blocked by | `RELATED-TO` with the dependency type (RFC 9253) |
| Reminders | `VALARM` |

The note body is **not** synced. Anything the plugin doesn't model — a description written on the phone, attachments, other custom `X-` properties — is left exactly as it was on the server.

**Statuses.** TaskNotes lets you define your own, CalDAV has a fixed set. A status marked *completed* becomes `COMPLETED`, one marked *skipped* becomes `CANCELLED`, everything else `NEEDS-ACTION`. Coming back, `NEEDS-ACTION` maps to your first open status by order.

**Priorities.** CalDAV has 1–9 plus 0 for *not set*, and task apps show them in three bands: 1–4 high, 5 medium, 6–9 low. By default your lowest-weight priority is sent as 9, the next as 5, and the rest are shared across 1–4, highest weight first; a priority with weight 0 is *not set*. With TaskNotes' own low/normal/high that is 9/5/1, what Apple Reminders uses. Under **Priorities** in the settings you can pick the number for each one. A number coming back that matches none of yours goes to the nearest priority in the same band, so a *medium* set on the phone never turns into a high one. Clearing the priority on the phone sets the note to your weight-0 priority.

**The task tag.** TaskNotes recognises task notes by a tag (`#task` by default). Every synced task would carry it, so it's left off the server unless you turn on *Sync the task tag*. Your notes always keep it, even when a phone app edits or drops a task's categories.

**Subtasks.** A subtask is a task whose *Projects* field links to another task, and it arrives on the server as a real subtask. A link is only sent once both tasks exist on the server.

**Projects.** A task whose *Projects* field links a plain note (one that isn't a task) carries those notes' names in `X-TASKNOTES-PROJECTS`. Task apps don't show that, so the title on the server also starts with the first project: `House | Fix the roof`. The prefix only exists on the server; your note's title stays `Fix the roof`. Edit the prefix on the phone and it's put back on the next sync. A task that belongs to a project only through its parent task gets no prefix, since it sits under that parent anyway.

## Task lists, tags and projects

An account is one server login; it can sync any number of its lists. Each list gets tags, and the rows are tried top to bottom:

- **A new task** goes to the first list whose tags it has (nested tags count: `work` also matches `work/client`), otherwise to the *Everything else* list, otherwise nowhere.
- **Project tasks** are tasks whose *Projects* field links a plain note, or subtasks of a task that does, however deep. A whole subtask tree counts, which matters because task apps only nest subtasks within a list. With a list chosen under **Project tasks**, every project task goes there, ahead of its tags, and leaves it again once it no longer belongs to a project. Leave it at *Route by tags* and project tasks are routed like any other task.
- **Never sync project tasks** keeps them off the server entirely. Unlike *Never sync* tags, this also applies to tasks already synced: when a synced task joins a project (or its parent does), its copy is deleted from the server and its `caldav_*` keys are removed from the note on its next push or sync.
- **Changing a task's tags** moves it: tag a Home task `#work` and it is deleted from Home and created in Work, with the same UID and anything a phone app added (a description, say) carried over. A task stays put as long as it still has one of its list's tags, so a Work task that also gets `#home` stays in Work. Losing its list's tag sends it to *Everything else*; with nowhere to go, it stays where it is.
- **Moving a task between lists on the phone** swaps its tags: moved from Work to Home, the note loses `#work` and gains `#home`. It is not mistaken for a deletion. Moved out of the project list, the task loses its links to project notes, or it would go straight back; a subtask whose parent is in a project goes back anyway.
- **A task created in a list on the phone** arrives with that list's first tag. In the project list, write the project in front of the title, `House | Fix the roof`: if *House* is a note in your vault, the task is linked to it and arrives as `Fix the roof`. A task in the project list with no project the plugin can find moves out to its tag list or *Everything else* on the next sync, unless the project list has tags of its own.
- **The routing tag stays off the server.** Every task in Work would carry `work`, so it's hidden like the task tag, and a phone app editing categories can't remove it from the note.
- **Editing a list's tags in settings** moves the affected tasks on the next sync. **Removing a list** moves its tasks where their tags now point; a task with nowhere to go is unlinked, and its copy stays on the server.
- **Never sync** tags and *Only tasks in folders* only decide which tasks get picked up. A task that's already synced keeps syncing when it gains a *Never sync* tag or leaves those folders; unlink it to stop.
- **A never-sync folder takes tasks out of sync.** Move a synced note into one and, on its next push or sync, its copy is deleted from the server and its `caldav_*` keys are removed from the note. Nothing else in the note changes. The server copy has to go, because a copy nothing links to would come back as a new note on the next poll.

**When a task matches several lists**, the project list wins, then the first list from the top whose tags it has; reorder lists with the arrow. A task already in a list stays there while it still has that list's tags. Across accounts, see *Several accounts* below.

Upgrading from 0.5: lists no longer route by project. The first list that did becomes the project list, and on the next sync every project task moves there, including tasks a tag had sent elsewhere. Run **Sync tasks with CalDAV now** once afterwards to put the project prefix on tasks that were already synced. A task edited while it synced nowhere (say, before you added the list its tag points to) used to stay off the server until its next edit even after it came into scope. It now uploads on the next sync, but a task edited that way before the upgrade still needs one more edit.

Upgrading from 0.4: *Only tasks in folder* becomes a one-entry folder list. If the default priority numbers changed for you, the first sync after the upgrade sends every affected task once more with its new number. Nothing in your notes changes.

Upgrading from 0.3: an account's list becomes its only list. An include tag filter becomes that list's tags; otherwise the list takes *Everything else*, and an exclude filter becomes *Never sync*. Nothing in your notes changes.

## How it behaves

- **Timing.** Local edits are pushed about 1.5 seconds after you stop typing, whether you edit through TaskNotes or type straight into the frontmatter. Server changes are polled per account (every 15 minutes by default), and a poll that finds the list unchanged stops after a single request.
- **Conflicts.** If both sides changed since the last sync, the server rejects the write (ETag mismatch) and the more recently changed side wins. This compares your computer's clock with the server's, so both should be roughly right.
- **Deleting.** Deleting a note deletes the task on the server. When a task disappears from the server you choose per account: archive the note (default), keep it and stop syncing, or delete it.
- **Dates the server can't take as-is.** CalDAV requires start and due to be the same kind (both dates or both date-times) and due not to come before start; TaskNotes allows both. On the server, a plain date next to a timed one gets a time (start 00:00, due 23:59), and a start after the due date is left out. Your notes keep their own values, and a sync only writes a field back into a note when the server actually changed it.
- **One bad task doesn't block the rest.** A task the server rejects is skipped, the rest of the sync carries on, and a notice names the task and the server's reason. It's retried on the next sync.
- **Archived tasks** are never uploaded.
- **Several accounts.** A task already synced stays with its account; a new one goes to the first enabled account that routes it somewhere, so it's never uploaded twice.
- **Offline.** A push that fails is queued and retried every minute, up to five attempts.
- **Unlinking** removes the `caldav_*` keys and deletes nothing on either side. The link is also what stops a task being uploaded twice, so syncing the same list again afterwards gives you a second copy of every task.

## Known limitations

- If TaskNotes stores titles in filenames (its default), characters that can't go in a filename, like `:`, are dropped from titles pulled in from the server. The server keeps its version; the plugin doesn't push the shortened title back.
- On a project task, everything up to the first ` | ` of the server title is taken as the prefix. If a phone app deletes the prefix from a title that itself contains ` | `, the part before it is lost.
- An `IN-PROCESS` status from the server can't be told apart from "not started" unless your statuses make it obvious. The plugin picks your second open status.
- If you disable TaskNotes while this plugin is running, sync stops. Reload this plugin after re-enabling TaskNotes.
- When a parent task joins or leaves a project, its subtasks follow (or, with *Never sync project tasks*, leave the server) on the next sync that finds something changed on the server, or on **Sync tasks with CalDAV now**. They don't follow right away, because their own notes didn't change.

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
src/caldav/               pure modules: CalDAV client, XML, ICS dates, VTODO mapping, routing, reconciliation
tests/caldav/             unit tests for src/caldav/
```

The pure modules in `src/caldav/` hold every sync decision (what a VTODO looks like, which list a task belongs to, who wins a conflict, what to upload) and do no I/O, which is why they're the part with unit tests. `CalDavSyncService` carries out those decisions: vault writes, timers, network.

### Releasing

```bash
npm version patch   # or minor / major: runs tests + build, bumps manifest.json and versions.json, commits, tags
npm run release     # pushes main and the tag to origin, Codeberg and GitHub
```

Pushing the tag triggers CI on GitHub and Codeberg, which builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a release. Tags carry no `v` prefix, because Obsidian looks releases up by the exact version in `manifest.json`.

## Credits

Built on [TaskNotes](https://github.com/callumalpass/tasknotes) by Callum Alpass and its runtime API. MIT licensed, see [LICENSE](LICENSE).
