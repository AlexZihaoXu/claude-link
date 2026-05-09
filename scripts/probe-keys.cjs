#!/usr/bin/env node
// Print the raw bytes that the terminal sends for each keystroke. Useful for
// figuring out what mintty / Windows Terminal / etc. actually sends for
// Backspace, Enter, etc.
//
// Run:  node scripts/probe-keys.cjs   (then press keys; Ctrl+C to exit)
//
// Standalone — does not depend on claude-link being installed.

"use strict";

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
}
process.stdin.resume();

console.log("press keys to see their byte sequences (Ctrl+C twice to exit)");
console.log("");

let lastWasCtrlC = false;
process.stdin.on("data", (chunk) => {
	const bytes = Array.from(chunk);
	const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
	const ascii = bytes
		.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`))
		.join("");
	console.log(`bytes: [${hex}]    interpreted: ${ascii}`);

	if (bytes.length === 1 && bytes[0] === 0x03) {
		if (lastWasCtrlC) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			process.exit(0);
		}
		lastWasCtrlC = true;
	} else {
		lastWasCtrlC = false;
	}
});
