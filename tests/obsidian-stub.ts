/** Just enough of the `obsidian` module for the pure CalDAV modules to load under Jest. */
export const requestUrl = (): never => {
	throw new Error("requestUrl is not available in tests; inject requestFn instead");
};
