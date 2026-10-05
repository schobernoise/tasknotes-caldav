import { DEFAULT_ACCOUNT, followRename, mergeSettings } from "../src/settings";

describe("mergeSettings", () => {
	it("fills in defaults, with the task tag not synced", () => {
		const settings = mergeSettings(undefined);
		expect(settings.syncTaskTag).toBe(false);
		expect(settings.accounts).toEqual([]);
	});

	it("turns a 0.3.x account without a tag filter into one default list with the account's id", () => {
		// The id is what notes carry in caldav_account, so it must not change.
		const [account] = mergeSettings({
			accounts: [{ id: "a", collectionUrl: "https://dav/personal/", scopeTags: [], scopeTagMode: "include", initialSyncCompleted: true } as never],
		}).accounts;
		expect(account.lists).toEqual([
			{ id: "a", url: "https://dav/personal/", name: "", tags: [], initialSyncCompleted: true },
		]);
		expect(account).toMatchObject({ defaultListId: "a", excludeTags: [] });
		expect(account).not.toHaveProperty("collectionUrl");
		expect(account).not.toHaveProperty("scopeTags");
	});

	it("turns an include filter into the list's routing tags, with nothing else synced", () => {
		const [account] = mergeSettings({
			accounts: [{ id: "a", collectionUrl: "https://dav/work/", scopeTags: ["work"], scopeTagMode: "include" } as never],
		}).accounts;
		expect(account.lists[0]).toMatchObject({ id: "a", tags: ["work"], initialSyncCompleted: false });
		expect(account).toMatchObject({ defaultListId: "", excludeTags: [] });
	});

	it("turns an exclude filter into never-sync tags on a default list", () => {
		const [account] = mergeSettings({
			accounts: [{ id: "a", collectionUrl: "https://dav/l/", scopeTags: ["private"], scopeTagMode: "exclude" } as never],
		}).accounts;
		expect(account.lists[0].tags).toEqual([]);
		expect(account).toMatchObject({ defaultListId: "a", excludeTags: ["private"] });
	});

	it("carries a 0.2.0 single scopeTag through to routing tags", () => {
		const [account] = mergeSettings({
			accounts: [{ id: "a", collectionUrl: "https://dav/l/", scopeTag: " work " } as never],
		}).accounts;
		expect(account.lists[0].tags).toEqual(["work"]);
		expect(account).not.toHaveProperty("scopeTag");
	});

	it("leaves an account without a chosen list without lists", () => {
		const [account] = mergeSettings({ accounts: [{ id: "a", collectionUrl: "" } as never] }).accounts;
		expect(account.lists).toEqual([]);
	});

	it("turns the single folder of a 0.4.x account into a one-folder include list", () => {
		const [account] = mergeSettings({
			accounts: [{ id: "a", lists: [], scopeFolder: " tasks/ " } as never],
		}).accounts;
		expect(account).toMatchObject({ includeFolders: ["tasks"], excludeFolders: [] });
		expect(account).not.toHaveProperty("scopeFolder");
	});

	it("drops an empty legacy folder without restricting anything", () => {
		const [account] = mergeSettings({ accounts: [{ id: "a", lists: [], scopeFolder: "" } as never] }).accounts;
		expect(account.includeFolders).toEqual([]);
	});

	it("keeps a 0.4.0 account as it is, with no project list", () => {
		const list = { id: "l", url: "u", name: "Work", tags: ["work"], initialSyncCompleted: true };
		const { projectListId, excludeProjectTasks, ...pre06 } = DEFAULT_ACCOUNT;
		const saved = { ...pre06, id: "a", lists: [list], defaultListId: "", excludeTags: ["x"] };
		expect(mergeSettings({ accounts: [saved as never] }).accounts[0]).toEqual({
			...DEFAULT_ACCOUNT,
			...saved,
		});
	});

	it("makes the first 0.5 list that routed by project the project list, and drops per-list projects", () => {
		const list = (id: string, projects: string[]) => ({ id, url: id, name: "", tags: [], projects, initialSyncCompleted: true });
		const lists = [list("w", []), list("b", ["Projects/Band.md"]), list("h", ["Projects/House.md"])];
		const [account] = mergeSettings({ accounts: [{ id: "a", lists } as never] }).accounts;
		expect(account.projectListId).toBe("b");
		expect(account.lists.some((migrated) => "projects" in migrated)).toBe(false);
	});

	it("keeps a project list choice once one was saved", () => {
		const lists = [{ id: "b", url: "b", name: "", tags: [], projects: ["Projects/Band.md"], initialSyncCompleted: true }];
		const [account] = mergeSettings({ accounts: [{ id: "a", lists, projectListId: "" } as never] }).accounts;
		expect(account.projectListId).toBe("");
	});
});

describe("followRename", () => {
	const settings = () =>
		mergeSettings({
			accounts: [
				{
					...DEFAULT_ACCOUNT,
					id: "a",
					includeFolders: ["Tasks", "Tasks2"],
					excludeFolders: ["Tasks/Old"],
				},
			],
		});

	it("follows a renamed folder into folder filters, leaving name-prefixed folders alone", () => {
		const renamed = settings();
		expect(followRename(renamed, "Tasks", "Todo")).toBe(true);
		expect(renamed.accounts[0]).toMatchObject({ includeFolders: ["Todo", "Tasks2"], excludeFolders: ["Todo/Old"] });
	});

	it("reports nothing changed for an unrelated rename", () => {
		expect(followRename(settings(), "Notes/a.md", "Notes/b.md")).toBe(false);
	});
});
