// Pinned so date tests behave the same on every machine; override with TZ=... jest.
process.env.TZ = process.env.TZ || "UTC";

module.exports = {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	roots: ["<rootDir>/tests"],
	setupFiles: ["<rootDir>/tests/setup.ts"],
	moduleNameMapper: { "^obsidian$": "<rootDir>/tests/obsidian-stub.ts" },
};
