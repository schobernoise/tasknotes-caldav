import { DEFAULT_ACCOUNT, mergeSettings } from "../src/settings";

describe("mergeSettings", () => {
	it("fills in defaults, with the task tag not synced", () => {
		const settings = mergeSettings(undefined);
		expect(settings.syncTaskTag).toBe(false);
		expect(settings.accounts).toEqual([]);
	});

	it("migrates a 0.2.0 single scopeTag into an include list", () => {
		const settings = mergeSettings({
			accounts: [{ id: "a", scopeTag: " work " } as never],
		});
		expect(settings.accounts[0]).toMatchObject({ scopeTags: ["work"], scopeTagMode: "include" });
		expect(settings.accounts[0]).not.toHaveProperty("scopeTag");
	});

	it("treats an empty legacy scopeTag as no restriction", () => {
		const settings = mergeSettings({ accounts: [{ id: "a", scopeTag: "" } as never] });
		expect(settings.accounts[0].scopeTags).toEqual([]);
	});

	it("keeps a saved tag list and mode as they are", () => {
		const settings = mergeSettings({
			accounts: [{ ...DEFAULT_ACCOUNT, id: "a", scopeTags: ["x"], scopeTagMode: "exclude" }],
		});
		expect(settings.accounts[0]).toMatchObject({ scopeTags: ["x"], scopeTagMode: "exclude" });
	});
});
