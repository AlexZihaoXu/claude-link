#!/usr/bin/env node
// Remove claude-link's MCP tools from the user-scope permissions.allow list.

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const settingsPath =
	process.env.CLAUDE_SETTINGS_PATH ||
	path.join(os.homedir(), ".claude", "settings.json");

let settings;
try {
	settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (err) {
	if (err.code === "ENOENT") {
		console.log("uninstall-permissions: nothing to clean (no settings.json)");
		process.exit(0);
	}
	throw err;
}

if (!settings.permissions || !Array.isArray(settings.permissions.allow)) {
	console.log("uninstall-permissions: nothing to clean");
	process.exit(0);
}

const before = settings.permissions.allow.length;
settings.permissions.allow = settings.permissions.allow.filter(
	(e) => typeof e !== "string" || !e.startsWith("mcp__claude-link__"),
);
const removed = before - settings.permissions.allow.length;

if (settings.permissions.allow.length === 0) {
	delete settings.permissions.allow;
}
if (Object.keys(settings.permissions).length === 0) {
	delete settings.permissions;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`uninstall-permissions: removed ${removed} entries from ${settingsPath}`);
