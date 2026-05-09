#!/usr/bin/env node
// Add claude-link's MCP tools to the user-scope `permissions.allow` list in
// ~/.claude/settings.json so the agent doesn't ask for permission on every
// link_* call. Idempotent: re-running adds nothing if entries already exist.

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const settingsPath =
	process.env.CLAUDE_SETTINGS_PATH ||
	path.join(os.homedir(), ".claude", "settings.json");

const ALLOW = [
	"mcp__claude-link__link_whoami",
	"mcp__claude-link__link_set_name",
	"mcp__claude-link__link_connect",
	"mcp__claude-link__link_send",
	"mcp__claude-link__link_inbox",
	"mcp__claude-link__link_peers",
];

let settings = {};
try {
	settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (err) {
	if (err.code !== "ENOENT") {
		console.error(
			`install-permissions: could not parse ${settingsPath} — ${err.message}`,
		);
		console.error("  refusing to overwrite a malformed settings file.");
		process.exit(1);
	}
}

settings.permissions = settings.permissions || {};
settings.permissions.allow = Array.isArray(settings.permissions.allow)
	? settings.permissions.allow
	: [];

let added = 0;
for (const entry of ALLOW) {
	if (!settings.permissions.allow.includes(entry)) {
		settings.permissions.allow.push(entry);
		added++;
	}
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

if (added > 0) {
	console.log(
		`install-permissions: added ${added} entr${added === 1 ? "y" : "ies"} to ${settingsPath}`,
	);
} else {
	console.log("install-permissions: all entries already present (no change)");
}
