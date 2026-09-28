import { Notice, Plugin } from "obsidian";

import { CalDavSyncService, EMPTY_SYNC_STATE, type SyncState } from "./CalDavSyncService";
import { createLogger, logConfig } from "./log";
import { mergeSettings, type CalDavSettings } from "./settings";
import { CalDavSettingTab, confirm } from "./SettingsTab";
import { getTaskNotesApi } from "./tasknotes";

interface PluginData {
	settings: CalDavSettings;
	state: SyncState;
}

const logger = createLogger("Plugin");

export default class CalDavPlugin extends Plugin {
	data!: PluginData;
	/** Null until TaskNotes is ready, and again after TaskNotes unloads. */
	sync: CalDavSyncService | null = null;

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: mergeSettings(loaded?.settings),
			state: { ...structuredClone(EMPTY_SYNC_STATE), ...loaded?.state },
		};
		logConfig.debug = this.data.settings.debugLogging;

		this.addSettingTab(new CalDavSettingTab(this.app, this));
		this.addCommand({
			id: "sync-now",
			name: "Sync tasks with CalDAV now",
			callback: () => void this.syncNow(),
		});
		this.addCommand({
			id: "unlink-all-tasks",
			name: "Unlink all tasks from CalDAV",
			callback: () => void this.unlinkAll(),
		});

		// TaskNotes may load after us; its API only exists once every plugin is up.
		this.app.workspace.onLayoutReady(() => void this.connect());
	}

	onunload(): void {
		this.sync?.destroy();
		this.sync = null;
	}

	private async connect(): Promise<void> {
		let api;
		try {
			api = getTaskNotesApi(this.app);
		} catch (error) {
			logger.error("Not starting CalDAV sync", { error });
			this.notify(`CalDAV sync is not running: ${(error as Error).message}.`);
			return;
		}
		await api.lifecycle.ready();

		const sync = new CalDavSyncService(this, api);
		this.sync = sync;

		this.registerEvent(
			api.events.on("task.updated", (event) => {
				if (!event.taskPath) return;
				this.sync?.handleTaskUpdated(event.taskPath, event.after).catch((error: unknown) =>
					logger.error("Failed to handle task update", { error })
				);
			})
		);
		// Task events carry no frontmatter for a deleted file; Obsidian's cache
		// event still has the previous one, which is where href and ETag live.
		this.registerEvent(
			this.app.metadataCache.on("deleted", (file, prevCache) => {
				this.sync?.handleTaskFileDeleted(file.path, prevCache?.frontmatter).catch(
					(error: unknown) => logger.error("Failed to delete remote task", { error })
				);
			})
		);
		this.registerEvent(
			api.lifecycle.on("unloading", () => {
				this.onunload();
				this.notify("TaskNotes was unloaded, so CalDAV sync stopped. Reload this plugin after re-enabling TaskNotes.");
			})
		);

		sync.initialize();
		logger.info("CalDAV sync started", {
			details: { accounts: this.data.settings.accounts.filter((a) => a.enabled).length },
		});
	}

	async saveState(): Promise<void> {
		await this.saveData(this.data);
	}

	async saveSettings(): Promise<void> {
		logConfig.debug = this.data.settings.debugLogging;
		await this.saveData(this.data);
		this.sync?.reschedulePolls();
	}

	notify(message: string): void {
		new Notice(message);
	}

	private async syncNow(): Promise<void> {
		if (!this.sync) {
			this.notify("CalDAV sync is not running. Check that TaskNotes is enabled.");
			return;
		}
		const { synced, failed } = await this.sync.syncAllAccounts();
		this.notify(
			failed === 0
				? `CalDAV sync finished (${synced} account(s)).`
				: `CalDAV sync failed for ${failed} of ${synced + failed} account(s). See the developer console.`
		);
	}

	private async unlinkAll(): Promise<void> {
		if (!this.sync) {
			this.notify("CalDAV sync is not running. Check that TaskNotes is enabled.");
			return;
		}
		const confirmed = await confirm(this.app, {
			title: "Unlink all tasks",
			message:
				"Remove the CalDAV link from every task in this vault? Nothing is deleted, here or on the server. The link is what stops a task syncing twice, so if you sync this vault with the same list again afterwards, you will get a second copy of every task.",
			cta: "Unlink",
			destructive: true,
		});
		if (!confirmed) return;

		const count = await this.sync.unlinkAllTasks();
		this.notify(`Unlinked ${count} task(s) from CalDAV.`);
	}
}
