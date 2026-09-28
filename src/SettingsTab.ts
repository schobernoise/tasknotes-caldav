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
import { noticeFailures, type ListFirstSyncPreview } from "./CalDavSyncService";
import { summarizeFirstSyncPlan } from "./caldav/caldavReconciliation";
import { createLogger } from "./log";
import {
	DEFAULT_ACCOUNT,
	type CalDavAccountSettings,
	type CalDavRemoteDeletionPolicy,
	type CalDavTaskList,
} from "./settings";

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

		const taskTag = this.plugin.sync?.taskTags()[0];
		new Setting(containerEl)
			.setName("Sync the task tag")
			.setDesc(
				`Send the tag TaskNotes uses to recognise task notes${taskTag ? ` (#${taskTag})` : ""} to the server. Every synced task carries it, so it is off by default. Your notes keep the tag either way.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.settings.syncTaskTag).onChange((value) => {
					this.settings.syncTaskTag = value;
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
			.setDesc("Connect another CalDAV server or login.")
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

		this.renderLists(body, account);
		this.text(
			body,
			account,
			"scopeFolder",
			"Only tasks in folder",
			"Pick up only tasks inside this folder (subfolders included). Leave empty for no folder restriction.",
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

		this.actionButton(actions, "git-compare", "Preview first sync")
			.setTooltip("Compare new task lists against your vault before anything is written")
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

	/**
	 * The routing table: one row per list with the tags that send tasks there,
	 * then where everything else goes and what never syncs.
	 */
	private renderLists(body: HTMLElement, account: CalDavAccountSettings): void {
		new Setting(body)
			.setName("Task lists")
			.setDesc("A task goes to the first list whose tags it has. When its tags change, it moves.")
			.setHeading()
			.addButton((button) =>
				button.setButtonText("Discover").onClick(() => void this.discoverCollections(account))
			);

		account.lists.forEach((list, index) => {
			const row = new Setting(body).setName(list.name || list.url).setClass("tasknotes-caldav-list");
			row.nameEl.createSpan({
				cls: `tasknotes-caldav-list__status is-${list.initialSyncCompleted ? "syncing" : "setup"}`,
				text: list.initialSyncCompleted ? "Syncing" : "Needs first sync",
			});
			const hint = list.id === account.defaultListId ? "Also takes everything else." : "Add at least one tag.";
			this.renderTagChips(row.descEl, list.tags, list.tags.length === 0 ? hint : "", (tags) => {
				list.tags = tags;
				this.save();
			});
			row.addExtraButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Try this list earlier")
					.setDisabled(index === 0)
					.onClick(() => {
						account.lists.splice(index - 1, 0, ...account.lists.splice(index, 1));
						this.save();
						this.display();
					})
			);
			row.addExtraButton((button) =>
				button
					.setIcon("x")
					.setTooltip("Stop syncing this list")
					.onClick(() => void this.removeList(account, list))
			);
		});

		const unrouted = (this.discovered.get(account.id) ?? []).filter(
			(collection) => !account.lists.some((list) => list.url === collection.url)
		);
		const add = new Setting(body).setName("Route another list");
		if (unrouted.length === 0) {
			add.setDesc(
				this.discovered.has(account.id)
					? "Every list on this server is already routed."
					: "Use Discover to find the lists this account can reach."
			);
		} else {
			add.addDropdown((dropdown) => {
				dropdown.addOption("", "Choose a list");
				for (const collection of unrouted) dropdown.addOption(collection.url, collection.displayName);
				dropdown.onChange((url) => {
					this.addList(account, url);
					this.display();
				});
			});
		}

		new Setting(body)
			.setName("Everything else")
			.setDesc("Where tasks go that have none of the tags above.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Don't sync");
				for (const list of account.lists) dropdown.addOption(list.id, list.name || list.url);
				for (const collection of unrouted) dropdown.addOption(collection.url, collection.displayName);
				dropdown.setValue(account.defaultListId).onChange((value) => {
					account.defaultListId = account.lists.some((list) => list.id === value)
						? value
						: value && this.addList(account, value).id;
					this.save();
					this.display();
				});
			});

		const never = new Setting(body).setName("Never sync");
		this.renderTagChips(never.descEl, account.excludeTags, "Tasks with any of these tags are not picked up.", (tags) => {
			account.excludeTags = tags;
			this.save();
		});
	}

	private addList(account: CalDavAccountSettings, url: string): CalDavTaskList {
		const collection = this.discovered.get(account.id)?.find((candidate) => candidate.url === url);
		const list: CalDavTaskList = {
			id: `list-${Date.now().toString(36)}`,
			url,
			name: collection?.displayName ?? "",
			tags: [],
			initialSyncCompleted: false,
		};
		account.lists.push(list);
		this.save();
		return list;
	}

	/** Tag chips with a remove button each, and an input that adds one on Enter. */
	private renderTagChips(
		parent: HTMLElement,
		initial: readonly string[],
		hint: string,
		onChange: (tags: string[]) => void
	): void {
		let tags = [...initial];
		if (hint) parent.createDiv({ text: hint });
		const list = parent.createDiv({ cls: "tasknotes-caldav-tags" });
		const render = () => {
			list.empty();
			for (const tag of tags) {
				const chip = list.createSpan({ cls: "tasknotes-caldav-tags__chip", text: `#${tag}` });
				const remove = chip.createSpan({ cls: "tasknotes-caldav-tags__remove", attr: { "aria-label": `Remove #${tag}` } });
				setIcon(remove, "x");
				remove.onclick = () => {
					tags = tags.filter((candidate) => candidate !== tag);
					onChange(tags);
					render();
				};
			}
			const input = list.createEl("input", {
				cls: "tasknotes-caldav-tags__input",
				attr: { type: "text", placeholder: "Add tag, press Enter" },
			});
			input.onkeydown = (event) => {
				if (event.key !== "Enter") return;
				const tag = input.value.trim().replace(/^#/u, "");
				const known = tags.some((existing) => existing.toLowerCase() === tag.toLowerCase());
				if (tag && !known) {
					tags = [...tags, tag];
					onChange(tags);
				}
				render();
				list.querySelector<HTMLInputElement>(".tasknotes-caldav-tags__input")?.focus();
			};
		};
		render();
	}

	private renderAccountHeader(header: HTMLElement, account: CalDavAccountSettings): void {
		header.empty();
		const status = this.accountStatus(account);
		header.createDiv({ cls: `tasknotes-caldav-account__dot is-${status.kind}` });
		const info = header.createDiv({ cls: "tasknotes-caldav-account__info" });
		info.createDiv({ cls: "tasknotes-caldav-account__title", text: account.name || "Unnamed account" });
		info.createDiv({
			cls: "tasknotes-caldav-account__subtitle",
			text: account.lists.map((list) => list.name || list.url).join(", ") || account.serverUrl || "CalDAV server",
		});
		header.createSpan({ cls: `tasknotes-caldav-account__badge is-${status.kind}`, text: status.label });
	}

	private accountStatus(account: CalDavAccountSettings): {
		kind: "syncing" | "paused" | "setup";
		label: string;
	} {
		if (!this.secretStore.hasCredentials(account.id) || account.lists.length === 0) {
			return { kind: "setup", label: "Setup incomplete" };
		}
		if (!account.enabled) return { kind: "paused", label: "Paused" };
		if (account.lists.some((list) => !list.initialSyncCompleted)) {
			return { kind: "setup", label: "First sync pending" };
		}
		return { kind: "syncing", label: "Syncing" };
	}

	private text(
		containerEl: HTMLElement,
		account: CalDavAccountSettings,
		key: "name" | "serverUrl" | "username" | "scopeFolder",
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
			const client = new CalDavClient({ serverUrl: account.serverUrl, credentials });
			const collections = await client.discoverCollections();
			if (collections.length === 0) {
				new Notice("No task lists were found for this account.");
				return;
			}

			this.discovered.set(account.id, collections);
			// Names can change on the server; the stored ones are only for display.
			for (const list of account.lists) {
				list.name = collections.find((collection) => collection.url === list.url)?.displayName ?? list.name;
			}
			this.save();
			new Notice(`Found ${collections.length} task list(s).`);
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

		try {
			const previews = await this.plugin.sync.previewFirstSync(account.id);
			if (previews.length === 0) {
				new Notice("Every list of this account has had its first sync.");
				return;
			}

			// The first sync is the one destructive moment: a mis-routed tag or a
			// wrong list is cheap to catch here and expensive afterwards.
			const confirmed = await confirm(this.app, {
				title: "Review the first sync",
				message: [...previews.map(describePreview), "Nothing has been written yet."],
				cta: "Sync now",
			});
			if (!confirmed) return;

			const failures = await this.plugin.sync.applyFirstSync(account.id, previews);
			if (failures.length > 0) noticeFailures(failures);
			else new Notice("First sync finished.");
			this.display();
		} catch (error) {
			this.reportError(error);
		}
	}

	private async removeList(account: CalDavAccountSettings, list: CalDavTaskList): Promise<void> {
		if (!this.plugin.sync) {
			new Notice("CalDAV sync is not running. Check that TaskNotes is enabled.");
			return;
		}
		const name = list.name || list.url;
		const confirmed = await confirm(this.app, {
			title: "Stop syncing this list",
			message: `Stop syncing "${name}"? Its tasks move to the list their tags now route them to. A task with nowhere to go keeps its note but is unlinked, and its copy stays in "${name}" on the server.`,
			cta: "Stop syncing",
			destructive: true,
		});
		if (!confirmed) return;

		try {
			const failures = await this.plugin.sync.removeList(account.id, list.id);
			if (failures.length > 0) noticeFailures(failures);
			this.display();
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
	options: { title: string; message: string | string[]; cta: string; destructive?: boolean }
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let confirmed = false;
		modal.titleEl.setText(options.title);
		for (const paragraph of [options.message].flat()) modal.contentEl.createEl("p", { text: paragraph });
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

function describePreview({ list, plan, moveIn }: ListFirstSyncPreview): string {
	const summary = summarizeFirstSyncPlan(plan);
	return `${list.name || list.url}: ${summary.upload} to upload, ${summary.import} to import, ${summary.link} already matching, ${summary.resolve} changed on both sides, ${moveIn.length} moving in from other lists.`;
}
