import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkRocq, resolveRocqBinary, rocqToolFor, splitRocqSentences, type RocqRunner } from "../src/agent/tools/rocq.ts";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/rocq-${name}.txt`, import.meta.url), "utf8");
const completed = "From Stdlib Require Import Arith.\nTheorem t : forall n : nat, n = n.\nProof.\nintro n.\nreflexivity.\nQed.\n";
const failing = "Theorem t : forall n : nat, n = n.\nProof.\nintro n.\napply Nat.add_0_r.\nreflexivity.\nQed.\n";
const unfinished = "Theorem t : forall n : nat, n = n.\nProof.\nintro n.\n";
const bullets = "Theorem t : forall a b : nat, a = a /\\ b = b.\nProof.\nintros a b.\nsplit.\n- reflexivity.\n- reflexivity.\nQed.\nCompute (2 + 3).\n";
const admitted = "Theorem t : True.\nProof.\nAdmitted.\n";
const admittedTactics = "Theorem t : True.\nProof.\nadmit.\nAbort.\nTheorem u : True.\nProof.\ngive_up.\nAbort.\n";
const noAdmission = "Theorem admit_foo : True.\nProof.\n(* Admitted. admit give_up *)\nexact I.\nQed.\n";
const fromFixture = (name: string, timedOut = false): RocqRunner => async () => ({
	stdout: fixture(name), stderr: "", exitCode: timedOut ? null : 0, timedOut,
});

const labels = (script: string) => splitRocqSentences(script).map(({ text, line }) => [line, text]);

describe("Rocq sentence splitting", () => {
	it("ignores nested comments and doubled-quote strings without losing line positions", () => {
		assert.deepEqual(labels('(* outer. (* inner. *) end. *)\nCheck "a. ""quoted. text"" b".\n(* comment. *)\nCheck Nat.add_0_r.\n'), [
			[2, 'Check "a. ""quoted. text"" b".'], [4, "Check Nat.add_0_r."],
		]);
		assert.deepEqual(labels("(* nothing. (* still. *) *)\n"), []);
	});

	it("splits bullets, braces and focused-goal selectors independently of tactics", () => {
		assert.deepEqual(labels("Goal True.\nProof.\n-- exact I.\n2:{ exact I. }\n{ exact I. }\nQed."), [
			[1, "Goal True."], [2, "Proof."], [3, "--"], [3, "exact I."],
			[4, "2:{"], [4, "exact I."], [4, "}"], [5, "{"], [5, "exact I."], [5, "}"], [6, "Qed."],
		]);
	});

	it("ends sentences only at a period followed by whitespace or EOF", () => {
		assert.deepEqual(labels("Check Nat.add_0_r.Check.\nCheck Nat.add_0_r."), [
			[1, "Check Nat.add_0_r.Check."], [2, "Check Nat.add_0_r."],
		]);
	});
});

describe("Rocq REPL transcript alignment (recorded from Rocq 9.0.0)", () => {
	it("reports the actual goals and complete status for a closed proof", async () => {
		const text = await checkRocq(completed, "/fake/rocq", fromFixture("complete"));
		assert.match(text, /\[2\] line 2: Theorem t : forall n : nat, n = n\.\n1 goal \(ID 2\)/);
		assert.match(text, /\[4\] line 4: intro n\.\n1 goal \(ID 3\)[\s\S]*n : nat/);
		assert.match(text, /\[5\] line 5: reflexivity\.\nNo more goals\./);
		assert.match(text, /\[6\] line 6: Qed\.\n\(no output\)\nstatus: complete$/);
	});

	it("stops at the first error even when repl subsequently succeeds", async () => {
		const text = await checkRocq(failing, "/fake/rocq", fromFixture("error"));
		assert.match(text, /\[4\] line 4: apply Nat\.add_0_r\.\nToplevel input, characters 6-17:/);
		assert.match(text, /Error: The reference Nat\.add_0_r was not found/);
		assert.doesNotMatch(text, /\[5\] line 5: reflexivity|No more goals/);
		assert.match(text, /status: error at step 4$/);
	});

	it("marks an open proof unfinished rather than treating a clean exit as Qed", async () => {
		const text = await checkRocq(unfinished, "/fake/rocq", fromFixture("unfinished"));
		assert.match(text, /\[3\] line 3: intro n\.\n1 goal \(ID 3\)/);
		assert.match(text, /status: proof unfinished$/);
	});

	it("flags an Admitted command as an admitted proof, not a solved proof", async () => {
		const text = await checkRocq(admitted, "/fake/rocq", fromFixture("admitted"));
		assert.match(text, /\[3\] line 3: Admitted\.\n<infomsg>t is declared<\/infomsg>/);
		assert.match(text, /status: complete with admitted proof\(s\) at step 3$/);
	});

	it("flags admit and give_up tactics at their actual sentence steps", async () => {
		const text = await checkRocq(admittedTactics, "/fake/rocq", fromFixture("admit-give-up"));
		assert.match(text, /\[3\] line 3: admit\.\n<infomsg>No more goals/);
		assert.match(text, /\[7\] line 7: give_up\.\n<infomsg>No more goals/);
		assert.match(text, /status: complete with admitted proof\(s\) at step 3, 7$/);
	});

	it("does not flag comments or identifier admit_foo as admission", async () => {
		const text = await checkRocq(noAdmission, "/fake/rocq", fromFixture("admit-word-safe"));
		assert.match(text, /\[3\] line 4: exact I\.\nNo more goals\./);
		assert.match(text, /status: complete$/);
	});

	it("aligns bullet markers to separate steps and preserves Compute output", async () => {
		const text = await checkRocq(bullets, "/fake/rocq", fromFixture("bullets-compute"));
		assert.match(text, /\[5\] line 5: -\n1 goal \(ID 7\)/);
		assert.match(text, /\[6\] line 5: reflexivity\.\n<infomsg>/);
		assert.match(text, /\[7\] line 6: -\n1 goal \(ID 8\)/);
		assert.match(text, /\[8\] line 6: reflexivity\.\nNo more goals\./);
		assert.match(text, /\[10\] line 8: Compute \(2 \+ 3\)\.\n     = 5\n     : nat/);
		assert.match(text, /status: complete$/);
	});
});

describe("Rocq process and input boundaries", () => {
	it("refuses every filesystem/native command without starting a process", async () => {
		const commands = [
			'Load "a.v".', 'Declare ML Module "plugin".', 'Redirect "output" Check nat.', 'Cd "/tmp".',
			'Add LoadPath "/tmp".', 'Add Rec LoadPath "/tmp".', 'Add ML Path "/tmp".',
			'Extraction "a.ml" nat.', 'Separate Extraction nat.', 'Extraction Library nat.',
			'Recursive Extraction Library nat.', 'Drop nat.', 'Time Load "a.v".',
			'Fail Declare ML Module "plugin".', 'Timeout 2 Extraction "a.ml" nat.',
		];
		const never: RocqRunner = async () => { throw new Error("runner must not be called"); };
		for (const command of commands) {
			const output = await checkRocq(`Check nat.\n${command}\n`, "/fake/rocq", never);
			assert.match(output, new RegExp(`refused filesystem/native command: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(output, /status: error at step 2$/);
		}
		assert.match(await checkRocq("a".repeat(20_001), "/fake/rocq", never), /exceeds 20,000 characters/);
	});

	it("does not treat a forbidden word in nested comments or strings as a command", async () => {
		let calls = 0;
		const runner: RocqRunner = async () => {
			calls++;
			return { stdout: "<prompt>Rocq < 1 || 0 < </prompt>\n<prompt>Rocq < 2 || 0 < </prompt>\n", stderr: "", exitCode: 0, timedOut: false };
		};
		const text = await checkRocq('(* Load "file". (* Drop nat. *) *)\nCheck "Load. Drop.".\n', "/fake/rocq", runner);
		assert.equal(calls, 1);
		assert.match(text, /status: complete$/);
	});

	it("uses an isolated temp directory and forwards abort signals to the runner", async () => {
		const controller = new AbortController();
		let cwd = "";
		const runner: RocqRunner = async (_binary, _script, workingDir, signal) => {
			cwd = workingDir;
			assert.equal(signal, controller.signal);
			return { stdout: fixture("complete"), stderr: "", exitCode: 0, timedOut: false };
		};
		await checkRocq(completed, "/fake/rocq", runner, controller.signal);
		assert.ok(cwd.startsWith(path.join(os.tmpdir(), "lh-rocq-")));
		assert.throws(() => statSync(cwd), /ENOENT/);
	});

	it("returns partial steps and timeout status when the runner hits its deadline", async () => {
		const stdout = fixture("unfinished").split("<prompt>t < 3 |t| 0 < </prompt>")[0]!;
		const runner: RocqRunner = async () => ({ stdout, stderr: "", exitCode: null, timedOut: true });
		const text = await checkRocq(unfinished, "/fake/rocq", runner);
		assert.match(text, /\[1\] line 1: Theorem t/);
		assert.match(text, /\[2\] line 2: Proof\.\n\(no output\)/);
		assert.doesNotMatch(text, /\[3\] line 3:/);
		assert.match(text, /status: timeout$/);
	});

	it("caps model-facing output and retains its truncation notice and status", async () => {
		const runner: RocqRunner = async () => ({ stdout: `<prompt>Rocq < 1 || 0 < </prompt>${"x".repeat(60_000)}\n<prompt>Rocq < 2 || 0 < </prompt>`, stderr: "", exitCode: 0, timedOut: false });
		const output = await checkRocq("Check nat.", "/fake/rocq", runner);
		assert.ok(Buffer.byteLength(output) <= 50 * 1024);
		assert.match(output, /\[Truncated: 50\.0KB output limit reached\]/);
		assert.match(output, /status: complete$/);
	});
});

describe("binary discovery and registration", () => {
	it("prefers executable LH_ROCQ, then opam, then first executable PATH entry", () => {
		const override = "/custom/rocq";
		const opam = "/student/.opam/default/bin/rocq";
		const first = "/one/rocq";
		const second = "/two/rocq";
		const available = new Set([override, opam, first, second]);
		const disk = {
			statSync: (name: string) => { if (!available.has(name)) throw new Error("missing"); return { isFile: () => true }; },
			accessSync: (name: string) => { if (!available.has(name)) throw new Error("not executable"); },
		} as never;
		const options = { env: { LH_ROCQ: override, PATH: "/one:/two" }, home: "/student", fs: disk };
		assert.equal(resolveRocqBinary(options), override);
		available.delete(override);
		assert.equal(resolveRocqBinary({ ...options, env: { ...options.env, LH_ROCQ: "./rocq" } }), opam);
		assert.equal(resolveRocqBinary(options), opam);
		available.delete(opam);
		assert.equal(resolveRocqBinary(options), first);
		available.delete(first);
		assert.equal(resolveRocqBinary(options), second);
		available.delete(second);
		assert.equal(resolveRocqBinary(options), null);
	});

	it("omits the tool when no binary exists or when the rocq setting is off", () => {
		const teacher: TeacherToolContext = { chatId: "c", chatStore: null as never, jobStore: null as never, spawn: () => {} };
		const practice = { chatId: "c", chatStore: { getChat: () => null } };
		assert.ok(!createTeacherTools(teacher, undefined, null).rocq_check);
		assert.ok(!practiceTools(practice, undefined, null).rocq_check);
		assert.ok(createTeacherTools(teacher, undefined, "/fake/rocq").rocq_check);
		assert.ok(practiceTools(practice, undefined, "/fake/rocq").rocq_check);
		assert.ok(!createTeacherTools(teacher, { rocq: false }, "/fake/rocq").rocq_check);
		assert.ok(!practiceTools(practice, { rocq: false }, "/fake/rocq").rocq_check);
	});

	it("the registered tool exposes model-facing real per-step results", async () => {
		const result = await rocqToolFor("/fake/rocq", fromFixture("error")).execute("call", { script: failing });
		const first = result.content[0];
		assert.equal(first?.type, "text");
		if (first?.type !== "text") throw new Error("Expected text output");
		assert.match(first.text, /status: error at step 4$/);
	});
});
