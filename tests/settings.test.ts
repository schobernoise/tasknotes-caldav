import { DEFAULT_ACCOUNT, mergeSettings } from "../src/settings";

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

	it("keeps a 0.4.0 account as it is", () => {
		const saved = {
			...DEFAULT_ACCOUNT,
			id: "a",
			lists: [{ id: "l", url: "u", name: "Work", tags: ["work"], initialSyncCompleted: true }],
			defaultListId: "",
			excludeTags: ["x"],
		};
		expect(mergeSettings({ accounts: [saved] }).accounts[0]).toEqual(saved);
	});
});
