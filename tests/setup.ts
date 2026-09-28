// jsdom omits TextEncoder, which Obsidian (Electron) provides; CalDavClient uses it for Basic auth.
import { TextEncoder } from "util";

Object.assign(globalThis, { TextEncoder });
