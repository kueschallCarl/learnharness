import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { missingProseReason } from "../src/agent/teacher-agent.ts";

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AgentMessage;
const think = () => ({ role: "assistant", content: [{ type: "thinking", thinking: "explained it" }] }) as unknown as AgentMessage;
const result = (toolName: string, isError = false) =>
	({ role: "toolResult", toolName, toolCallId: "x", content: [], isError }) as unknown as AgentMessage;
const learner = { role: "user", content: "next" } as unknown as AgentMessage;
const check = { type: "check" };

test("a check after only thinking and a rocq_check result is blocked", () => {
	const history = [say("old teaching"), result("quiz"), think(), result("rocq_check")];
	assert.ok(missingProseReason("quiz", check, history, think()));
});

test("visible text since the learner's answer allows the check", () => {
	assert.equal(missingProseReason("quiz", check, [result("quiz"), say("teaching"), result("rocq_check")], think()), undefined);
	assert.equal(missingProseReason("quiz", check, [result("quiz")], say("teaching in this message")), undefined);
});

test("text before the learner's last answer or message does not count", () => {
	assert.ok(missingProseReason("ask_user_question", {}, [say("old"), learner], think()));
	assert.ok(missingProseReason("explain", check, [say("old"), result("ask_user_question")], think()));
});

test("an earlier blocked question does not end the window", () => {
	assert.equal(missingProseReason("quiz", check, [result("quiz"), say("teaching"), result("quiz", true)], think()), undefined);
	assert.ok(missingProseReason("quiz", check, [say("old"), result("quiz"), result("quiz", true)], think()));
});

test("predictions and non-question tools are never blocked", () => {
	assert.equal(missingProseReason("quiz", { type: "predict" }, [result("quiz")], think()), undefined);
	assert.equal(missingProseReason("rocq_check", {}, [result("quiz")], think()), undefined);
});
