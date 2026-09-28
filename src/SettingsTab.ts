/**
 * CalDAV account configuration UI.
 *
 * Rendering is re-entrant: any change that alters which controls apply (adding
 * an account, discovering collections) re-renders the whole tab.
 */

import { App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";

import type CalDavPlugin from "./main";
import { CalDavClient, CalDavError, type CalDavCollectionInfo } from "./caldav/CalDavClient";
import { CalDavSecretStore } from "./caldav/CalDavSecretStore";
import { summarizeFirstSyncPlan } from "./caldav/caldavReconciliation";
import { createLogger } from "./log";
import { DEFAULT_ACCOUNT, type CalDavAccountSettings, type CalDavRemoteDeletionPolicy } from "./settings";

const logger = createLogger("Settings");

export class CalDavSettingTab extends PluginSettingTab {
	private readonly secretStore: CalDavSecretStore;
	/**
	 * Collections found by the last discovery, per account. Kept across renders
	 * because re-running discovery on every re-render would hammer the server.
	 */
	private readonly discovered = new Map<string, CalDavCollectionInfo[]>();

	constructor(
		app: App,
		private readonly plugin: CalDavPlugin
	) {
		super(app, plugin);
		this.secretStore = new CalDavSecretStore(app.secretStorage);
	}

	private get settings() {
		return this.plugin.data.settings;
	}

	private save(): void {
		void this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "Two-way sync between your TaskNotes tasks and a CalDAV task list, such as Nextcloud, Apple Reminders, Radicale or Baikal. Tasks sync as VTODO entries, not as calendar events.",
		});

		new Setting(containerEl)
			.setName("Push changes immediately")
			.setDesc("Send local edits to the server as they happen. When off, changes are sent on the next scheduled sync instead.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.pushOnChange).onChange((value) => {
					this.settings.pushOnChange = value;
					this.save();
				})
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log sync decisions to the developer console.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.debugLogging).onChange((value) => {
					this.settings.debugLogging = value;
					this.save();
				})
			);

		for (const account of this.settings.accounts) {
			this.renderAccount(containerEl, account);
		}

		new Setting(containerEl)
			.setName("Add account")
			.setDesc("Configure another CalDAV task list.")
			.addButton((button) =>
				button.setButtonText("Add account").onClick(() => {
					this.settings.accounts.push({
						...DEFAULT_ACCOUNT,
						id: `caldav-${Date.now().toString(36)}`,
						name: "New account",
					});
					this.save();
					this.display();
				})
			);
	}

	private renderAccount(containerEl: HTMLElement, account: CalDavAccountSettings): void {
		const card = containerEl.createDiv({ cls: "tasknotes-caldav-account" });
		const header = card.createDiv({ cls: "tasknotes-caldav-account__header" });
		const body = card.createDiv({ cls: "tasknotes-caldav-account__body" });
		const actions = card.createDiv({ cls: "tasknotes-caldav-account__actions" });
		const refreshHeader = () => this.renderAccountHeader(header, account);
		refreshHeader();

		this.text(body, account, "name", "Name", "A label for this account.", "", refreshHeader);
		this.text(
			body,
			account,
			"serverUrl",
			"Server URL",
			"Base URL of the CalDAV server. Credentials are only sent over HTTPS, except to localhost.",
			"https://cloud.example.com/remote.php/dav",
			refreshHeader
		);
		this.text(body, account, "username", "Username", "The account name on the CalDAV server.");

		// Write-only: the password lives in Obsidian's SecretStorage and is never
		// read back into the UI.
		new Setting(body)
			.setName("Password")
			.setDesc(
				this.secretStore.hasCredentials(account.id)
					? "A password is stored for this account. Type a new one to replace it."
					: "Stored in Obsidian secret storage, never in the plugin's data file. Use an app password where your provider offers one."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter a password").onChange((value) => {
					if (!value) return;
					try {
						this.secretStore.setCredentials(account.id, {
							username: account.username,
							password: value,
						});
						refreshHeader();
					} catch (error) {
						logger.error("Could not store CalDAV credentials", { error });
						new Notice("Could not save the password to secret storage.");
					}
				});
			})
			.addButton((button) =>
				button.setButtonText("Clear").onClick(() => {
					this.secretStore.clearCredentials(account.id);
					this.display();
				})
			);

		const discovered = this.discovered.get(account.id);
		const listSetting = new Setting(body).setName("Task list");
		if (discovered && discovered.length > 1) {
			// Several task lists can share a display name, so the URL is the only
			// thing that reliably tells them apart.
			listSetting.setDesc("Choose which list this account syncs with.").addDropdown((dropdown) => {
				for (const collection of discovered) {
					dropdown.addOption(collection.url, `${collection.displayName} (${collection.url})`);
				}
				dropdown.setValue(account.collectionUrl).onChange((value) => {
					account.collectionUrl = value;
					this.save();
					refreshHeader();
				});
			});
		} else {
			listSetting.setDesc(
				account.collectionUrl || "None selected yet. Use Discover below to find the lists this account can reach."
			);
		}

		this.text(
			body,
			account,
			"scopeTag",
			"Only tasks with tag",
			"Sync only tasks carrying this tag (nested tags included). Leave empty for no tag restriction.",
			"work"
		);
		this.text(
			body,
			account,
			"scopeFolder",
			"Only tasks in folder",
			"Sync only tasks inside this folder (subfolders included). Leave empty for no folder restriction.",
			"TaskNotes/Work"
		);

		new Setting(body)
			.setName("Check for changes every")
			.setDesc("How often to look for changes on the server, in minutes.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(account.syncIntervalMinutes)).onChange((value) => {
					const minutes = Number(value);
					if (!Number.isFinite(minutes)) return;
					account.syncIntervalMinutes = Math.max(1, Math.min(1440, Math.round(minutes)));
					this.save();
				});
			});

		new Setting(body)
			.setName("When a task is deleted on the server")
			.setDesc("What happens to the local note when its entry disappears from the server.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						archive: "Archive the note",
						unlink: "Keep the note and stop syncing it",
						delete: "Delete the note",
					})
					.setValue(account.remoteDeletionPolicy)
					.onChange((value) => {
						account.remoteDeletionPolicy = value as CalDavRemoteDeletionPolicy;
						this.save();
					})
			);

		new Setting(body)
			.setName("Sync this account")
			.setDesc("Turn syncing on once the details above are correct and the first sync is done.")
			.addToggle((toggle) =>
				toggle.setValue(account.enabled).onChange((value) => {
					account.enabled = value;
					this.save();
					refreshHeader();
				})
			);

		this.actionButton(actions, "search", "Discover task lists").onClick(
			() => void this.discoverCollections(account)
		);
		this.actionButton(actions, "git-compare", "Preview first sync")
			.setTooltip("Compare this task list against your vault before anything is written")
			.setCta()
			.onClick(() => void this.runFirstSyncPreview(account));
		actions.createDiv({ cls: "tasknotes-caldav-account__spacer" });
		this.actionButton(actions, "trash-2", "Remove")
			.setTooltip("Stop syncing and forget this account's stored password")
			.setWarning()
			.onClick(() => void this.removeAccount(account));
	}

	/** ButtonComponent.setIcon replaces the label, so icon and label get their own spans. */
	private actionButton(parent: HTMLElement, icon: string, label: string): ButtonComponent {
		const button = new ButtonComponent(parent);
		setIcon(button.buttonEl.createSpan({ cls: "tasknotes-caldav-account__button-icon" }), icon);
		button.buttonEl.createSpan({ text: label });
		return button;
	}

	private renderAccountHeader(header: HTMLElement, account: CalDavAccountSettings): void {
		header.empty();
		const status = this.accountStatus(account);
		header.createDiv({ cls: `tasknotes-caldav-account__dot is-${status.kind}` });
		const info = header.createDiv({ cls: "tasknotes-caldav-account__info" });
		info.createDiv({ cls: "tasknotes-caldav-account__title", text: account.name || "Unnamed account" });
		info.createDiv({
			cls: "tasknotes-caldav-account__subtitle",
			text: account.collectionUrl || account.serverUrl || "CalDAV task list",
		});
		header.createSpan({ cls: `tasknotes-caldav-account__badge is-${status.kind}`, text: status.label });
	}

	private accountStatus(account: CalDavAccountSettings): {
		kind: "syncing" | "paused" | "setup";
		label: string;
	} {
		if (!this.secretStore.hasCredentials(account.id) || !account.collectionUrl) {
			return { kind: "setup", label: "Setup incomplete" };
		}
		if (!account.enabled) return { kind: "paused", label: "Paused" };
		return { kind: "syncing", label: "Syncing" };
	}

	private text(
		containerEl: HTMLElement,
		account: CalDavAccountSettings,
		key: "name" | "serverUrl" | "username" | "scopeTag" | "scopeFolder",
		name: string,
		desc: string,
		placeholder = "",
		afterChange?: () => void
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(account[key])
					.onChange((value) => {
						account[key] = key === "name" ? value : value.trim();
						this.save();
						afterChange?.();
					})
			);
	}

	private async discoverCollections(account: CalDavAccountSettings): Promise<void> {
		const credentials = this.secretStore.getCredentials(account.id);
		if (!credentials) {
			new Notice("Enter a username and password for this account first.");
			return;
		}

		try {
			const client = new CalDavClient({
				serverUrl: account.serverUrl || account.collectionUrl,
				credentials,
			});
			const collections = await client.discoverCollections();
			if (collections.length === 0) {
				new Notice("No task lists were found for this account.");
				return;
			}

			this.discovered.set(account.id, collections);
			// Adopt the first result so a single-list account needs no further
			// input; with several, the dropdown lets the user correct it before
			// anything is written.
			if (!collections.some((collection) => collection.url === account.collectionUrl)) {
				account.collectionUrl = collections[0].url;
			}
			this.save();
			new Notice(`Found ${collections.length} task list(s). Using "${collections[0].displayName}".`);
			this.display();
		} catch (error) {
			this.reportError(error);
		}
	}

	private async runFirstSyncPreview(account: CalDavAccountSettings): Promise<void> {
		if (!this.plugin.sync) {
			new Notice("CalDAV sync is not running. Check that TaskNotes is enabled.");
			return;
		}
		if (!account.collectionUrl) {
			new Notice("Choose a task list for this account first.");
			return;
		}

		try {
			const plan = await this.plugin.sync.previewFirstSync(account.id);
			const summary = summarizeFirstSyncPlan(plan);

			// The first sync is the one destructive moment: a mis-scoped account or
			// a wrong collection is cheap to catch here and expensive afterwards.
			const confirmed = await confirm(this.app, {
				title: "Review the first sync",
				message: `${summary.upload} to upload, ${summary.import} to import, ${summary.link} already matching, ${summary.resolve} changed on both sides. Nothing has been written yet.`,
				cta: "Sync now",
			});
			if (!confirmed) return;

			await this.plugin.sync.applyFirstSync(account.id, plan);
			account.initialSyncCompleted = true;
			this.save();
			new Notice("First sync finished.");
		} catch (error) {
			this.reportError(error);
		}
	}

	private async removeAccount(account: CalDavAccountSettings): Promise<void> {
		const confirmed = await confirm(this.app, {
			title: "Remove account",
			message: `Remove "${account.name || account.id}"? Tasks already in your vault are kept, but they stop syncing and the stored password is deleted.`,
			cta: "Remove",
			destructive: true,
		});
		if (!confirmed) return;

		this.secretStore.clearCredentials(account.id);
		this.settings.accounts = this.settings.accounts.filter((candidate) => candidate.id !== account.id);
		this.save();
		this.display();
	}

	private reportError(error: unknown): void {
		logger.error("CalDAV settings action failed", { error });
		if (error instanceof CalDavError && error.kind === "auth") {
			new Notice("The server rejected those credentials.");
			return;
		}
		new Notice(`CalDAV request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function confirm(
	app: App,
	options: { title: string; message: string; cta: string; destructive?: boolean }
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let confirmed = false;
		modal.titleEl.setText(options.title);
		modal.contentEl.createEl("p", { text: options.message });
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((button) => {
				button.setButtonText(options.cta).onClick(() => {
					confirmed = true;
					modal.close();
				});
				if (options.destructive) button.setWarning();
				else button.setCta();
			});
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
