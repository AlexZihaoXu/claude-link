import { encodeProjectDir } from "../src/config/paths";

// Tests are gated by platform because path.resolve normalizes against the
// host OS — POSIX-shaped inputs on Windows turn into D:\… and vice versa.
const cases = process.platform === "win32"
	? [
			["D:\\Tools\\claude-link", "D--Tools-claude-link"],
			["C:\\Users\\Alex", "C--Users-Alex"],
			["D:\\Work\\Startup\\Lobbify\\lobbify-design-system", "D--Work-Startup-Lobbify-lobbify-design-system"],
		]
	: [
			["/Users/me/foo", "-Users-me-foo"],
			["/home/alice/projects/claude-link", "-home-alice-projects-claude-link"],
		];

let ok = true;
for (const [input, expected] of cases) {
	const got = encodeProjectDir(input!);
	const pass = got === expected;
	if (!pass) ok = false;
	console.log(`${pass ? "✔" : "✘"}  ${input}  →  ${got}  ${pass ? "" : `(expected ${expected})`}`);
}
process.exit(ok ? 0 : 1);
