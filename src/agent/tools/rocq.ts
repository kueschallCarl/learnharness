import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { serverExecute } from "../tool-execute.ts";
import { capOutput, formatSize, MAX_OUTPUT_BYTES } from "./fs-shared.ts";

const INPUT = Type.Object({ script: Type.String({ description: "Complete Rocq script, including its own imports" }) });
const MAX_SCRIPT_CHARS = 20_000;
const RUN_TIMEOUT_MS = 20_000;

export interface RocqSentence {
	text: string;
	line: number;
	/** Source with comments and quoted strings masked, preserving offsets. */
	code: string;
	/** Source with comments masked but strings retained (for Extraction paths). */
	uncommented: string;
}

/** Mask syntax without moving character or line offsets. Rocq comments nest; doubled quotes escape a quote. */
function maskSyntax(script: string): { code: string; uncommented: string } {
	const code: string[] = [];
	const uncommented: string[] = [];
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < script.length; i++) {
		const c = script[i]!;
		const next = script[i + 1];
		const hidden = c === "\n" ? "\n" : " ";
		if (depth > 0) {
			if ((c === "(" && next === "*") || (c === "*" && next === ")")) {
				depth += c === "(" ? 1 : -1;
				code.push(" ", " ");
				uncommented.push(" ", " ");
				i++;
			} else {
				code.push(hidden);
				uncommented.push(hidden);
			}
			continue;
		}
		if (quoted) {
			code.push(hidden);
			uncommented.push(c);
			if (c === '"' && next === '"') {
				code.push(" ");
				uncommented.push('"');
				i++;
			} else if (c === '"') quoted = false;
			continue;
		}
		if (c === "(" && next === "*") {
			depth = 1;
			code.push(" ", " ");
			uncommented.push(" ", " ");
			i++;
		} else if (c === '"') {
			quoted = true;
			code.push(" ");
			uncommented.push(c);
		} else {
			code.push(c);
			uncommented.push(c);
		}
	}
	return { code: code.join(""), uncommented: uncommented.join("") };
}

/** One source-labelled item per sentence, including bullets, braces and focused-goal selectors. */
export function splitRocqSentences(script: string): RocqSentence[] {
	const { code, uncommented } = maskSyntax(script);
	const sentences: RocqSentence[] = [];
	const selectorPattern = /\d+\s*:\s*\{/y;
	const bulletPattern = /(-+|\++|\*+)(?=\s|$)/y;
	let i = 0;
	let line = 1;
	while (i < code.length) {
		if (/\s/.test(code[i]!)) {
			if (code[i] === "\n") line++;
			i++;
			continue;
		}
		const start = i;
		const startLine = line;
		selectorPattern.lastIndex = i;
		bulletPattern.lastIndex = i;
		const selector = selectorPattern.exec(code);
		const bullet = bulletPattern.exec(code);
		if (selector) i += selector[0].length;
		else if (code[i] === "{" || code[i] === "}") i++;
		else if (bullet) i += bullet[0].length;
		else {
			while (i < code.length) {
				const c = code[i]!;
				if (c === "." && (i + 1 === script.length || /\s/.test(script[i + 1]!))) {
					i++;
					break;
				}
				i++;
			}
		}
		const end = i;
		for (let p = start; p < end; p++) if (code[p] === "\n") line++;
		sentences.push({
			text: script.slice(start, end).trim(),
			line: startLine,
			code: code.slice(start, end),
			uncommented: uncommented.slice(start, end),
		});
	}
	return sentences;
}

const FORBIDDEN = /^(?:Load\b|Declare\s+ML\s+Module\b|Redirect\b|Cd\b|Add\s+(?:Rec\s+)?LoadPath\b|Add\s+ML\s+Path\b|Separate\s+Extraction\b|(?:Recursive\s+)?Extraction\s+Library\b|Drop\b)/i;
const COMMAND_PREFIX = /^(?:(?:Time|Fail|Succeed|Local|Global)\s+|Timeout\s+\d+\s+)*/i;

function forbiddenCommand(sentence: RocqSentence): boolean {
	const code = sentence.code.trimStart().replace(COMMAND_PREFIX, "");
	const uncommented = sentence.uncommented.trimStart().replace(COMMAND_PREFIX, "");
	return FORBIDDEN.test(code) || (/^Extraction\b/i.test(code) && /^Extraction\s*"/i.test(uncommented));
}

export function resolveRocqBinary(options: {
	env?: { LH_ROCQ?: string; PATH?: string };
	home?: string;
	fs?: Pick<typeof fs, "statSync" | "accessSync">;
} = {}): string | null {
	const env = options.env ?? process.env;
	const home = options.home ?? os.homedir();
	const disk = options.fs ?? fs;
	const executable = (candidate: string): boolean => {
		try {
			if (!disk.statSync(candidate).isFile()) return false;
			disk.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (env.LH_ROCQ && path.isAbsolute(env.LH_ROCQ) && executable(env.LH_ROCQ)) return env.LH_ROCQ;
	const opam = path.join(home, ".opam", "default", "bin", "rocq");
	if (executable(opam)) return opam;
	for (const entry of (env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.resolve(entry || ".", "rocq");
		if (executable(candidate)) return candidate;
	}
	return null;
}

export interface RocqRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export type RocqRunner = (binary: string, script: string, cwd: string, signal?: AbortSignal) => Promise<RocqRunResult>;

/** One shared fd preserves the interleaving: Rocq writes prompts to stderr and goals to stdout. */
export const runRocq: RocqRunner = (binary, script, cwd, signal) => {
	if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
	return new Promise((resolve, reject) => {
		const transcript = path.join(cwd, "rocq-transcript.txt");
		const fd = fs.openSync(transcript, "w+");
		const child = spawn(binary, ["repl", "-q", "-emacs"], { cwd, stdio: ["pipe", fd, fd] });
		let timedOut = false;
		let spawnError: Error | null = null;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, RUN_TIMEOUT_MS);
		const abort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const stdin = child.stdin;
		if (stdin) {
			stdin.on("error", () => {}); // A process that exits early can close stdin before the script is written.
			stdin.end(script);
		} else {
			spawnError = new Error("Rocq stdin pipe unavailable");
			child.kill("SIGKILL");
		}
		child.on("error", (error) => { spawnError = error; });
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			try {
				const stdout = fs.readFileSync(transcript, "utf8");
				if (spawnError) reject(spawnError);
				else if (signal?.aborted) reject(new Error("Operation aborted"));
				else resolve({ stdout, stderr: "", exitCode, timedOut });
			} catch (error) {
				reject(error);
			} finally {
				fs.closeSync(fd);
			}
		});
	});
};

/** The prompt before each result belongs to that sentence; the final prompt is the EOF prompt. */
function formatRocqResult(sentences: RocqSentence[], result: RocqRunResult): string {
	const marker = /<prompt>[^<]*? < \d+ \|([^|]*)\| \d+ < <\/prompt>/g;
	const prompts = [...result.stdout.matchAll(marker)];
	const entries: string[] = [];
	let status = "complete";
	for (let i = 0; i < sentences.length; i++) {
		const prompt = prompts[i];
		if (!prompt) {
			if (!result.timedOut) {
				entries.push(`[${i + 1}] line ${sentences[i]!.line}: ${sentences[i]!.text}\n${result.stderr.trim() || result.stdout.trim() || "Rocq returned no result for this sentence."}`);
				status = `error at step ${i + 1}`;
			}
			break;
		}
		const end = prompt.index! + prompt[0].length;
		const output = result.stdout.slice(end, prompts[i + 1]?.index ?? result.stdout.length).replace(/^\n+/, "").replace(/\s+$/, "");
		entries.push(`[${i + 1}] line ${sentences[i]!.line}: ${sentences[i]!.text}\n${output || "(no output)"}`);
		if (/(?:^|\n)Error:/.test(output)) {
			status = `error at step ${i + 1}`;
			break;
		}
	}
	if (status === "complete") {
		if (result.timedOut) status = "timeout";
		else if (result.exitCode !== 0) {
			entries.push(result.stderr.trim() || `Rocq exited with code ${result.exitCode}.`);
			status = `error at step ${Math.max(1, sentences.length)}`;
		} else if (sentences.length && (prompts[sentences.length] ?? prompts[sentences.length - 1])?.[1]) status = "proof unfinished";
	}
	if (status === "complete") {
		const admitted: number[] = [];
		for (let i = 0; i < sentences.length; i++) {
			const code = sentences[i]!.code;
			if (/^\s*Admitted\b/.test(code) || /\b(?:admit|give_up)\b/.test(code)) admitted.push(i + 1);
		}
		if (admitted.length) status = `complete with admitted proof(s) at step ${admitted.join(", ")}`;
	}
	const statusLine = `status: ${status}`;
	const notice = `[Truncated: ${formatSize(MAX_OUTPUT_BYTES)} output limit reached]`;
	const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(`\n${notice}\n${statusLine}`);
	let bytes = 0;
	let count = 0;
	for (const entry of entries) {
		const size = Buffer.byteLength(entry) + (count ? 1 : 0);
		if (bytes + size > budget) break;
		bytes += size;
		count++;
	}
	return capOutput([...entries.slice(0, count), ...(count < entries.length ? [notice] : []), statusLine]).content;
}

export async function checkRocq(
	script: string,
	binary: string,
	runner: RocqRunner = runRocq,
	signal?: AbortSignal,
): Promise<string> {
	if (script.length > MAX_SCRIPT_CHARS) return `error: script exceeds ${MAX_SCRIPT_CHARS.toLocaleString("en-US")} characters\nstatus: error at step 1`;
	const sentences = splitRocqSentences(script);
	const forbidden = sentences.findIndex(forbiddenCommand);
	if (forbidden !== -1) return `error: refused filesystem/native command: ${sentences[forbidden]!.text}\nstatus: error at step ${forbidden + 1}`;
	const cwd = await files.mkdtemp(path.join(os.tmpdir(), "lh-rocq-"));
	try {
		return formatRocqResult(sentences, await runner(binary, script, cwd, signal));
	} finally {
		await files.rm(cwd, { recursive: true, force: true });
	}
}

export function rocqToolFor(binary: string, runner: RocqRunner = runRocq): AgentTool<typeof INPUT> {
	return {
		name: "rocq_check",
		label: "rocq_check",
		description: "Run a complete Rocq script and return each sentence with its source line and Rocq output; report the first error, an unfinished proof, or a timeout. Provide imports in the script field.",
		parameters: INPUT,
		execute: serverExecute("rocq_check", INPUT, ({ script }, { signal }) => checkRocq(script, binary, runner, signal)),
	};
}
