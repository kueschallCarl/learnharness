import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createModels, normalizeContext } from "@earendil-works/pi-ai";
import { cliProxyProvider } from "../src/agent/cliproxy.ts";
import { normalizeCLIProxyBaseUrl } from "../src/core/auth-keys.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { catalogProviders, modelCatalog } from "../src/server/model-catalog.ts";
import { providerKeyPresent } from "../src/server/keys.ts";

const savedFetch = globalThis.fetch;
const savedKey = process.env.CLIPROXY_API_KEY;
const savedBase = process.env.CLIPROXY_BASE_URL;
after(() => {
	globalThis.fetch = savedFetch;
	if (savedKey === undefined) delete process.env.CLIPROXY_API_KEY;
	else process.env.CLIPROXY_API_KEY = savedKey;
	if (savedBase === undefined) delete process.env.CLIPROXY_BASE_URL;
	else process.env.CLIPROXY_BASE_URL = savedBase;
});

const base = "http://127.0.0.1:8317";
const entries = [
	{ id: "max-claude-sonnet-5-5", owned_by: "anthropic" },
	{ id: "codex/gpt-6.1-sol", owned_by: "openai" },
	{ id: "unknown-chat", owned_by: "bedrock" },
	{ id: "copilot-claude-sonnet-5", owned_by: "github-copilot" },
	{ id: "openrouter/claude-sonnet-5", owned_by: "openrouter" },
	{ id: "codex/gpt-image-2", owned_by: "openai" },
	{ id: "bad-image-model", owned_by: "anthropic" },
	{ id: "video-maker", owned_by: "openai", type: "image" },
	{ id: "text-embedding-3-large", owned_by: "openai" },
	{ id: "whisper-1", owned_by: "openai" },
	{ id: "gpt-speech", owned_by: "openai", type: "audio" },
	{ id: null, owned_by: "openai" },
];

describe("CLIProxyAPI dynamic models", () => {
	it("normalizes http(s) origins and rejects malformed or credential-bearing URLs", () => {
		assert.equal(normalizeCLIProxyBaseUrl(" https://proxy.example/tenant/// "), "https://proxy.example/tenant");
		for (const url of ["", "file:///tmp/x", "not-a-url", "http://user:pass@proxy.example", "http://proxy.example/?token=secret", "http://proxy.example/v1"]) {
			assert.throws(() => normalizeCLIProxyBaseUrl(url), /base URL/i, url);
		}
	});

	it("fetches chat ids verbatim, routes by ownership and inherits matching native capabilities at zero cost", async () => {
		process.env.CLIPROXY_API_KEY = "test-proxy-key-123456";
		process.env.CLIPROXY_BASE_URL = base;
		const calls: Request[] = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			calls.push(request);
			if (request.url.endsWith("/v1/models")) return Response.json({ data: entries });
			return Response.json({ error: { message: "closed fixture" } }, { status: 400 });
		};
		const models = piModels();
		const result = await models.refresh({ providers: ["cliproxy"] });
		assert.equal(result.errors.size, 0);
		assert.equal(calls[0]?.url, `${base}/v1/models`);
		assert.equal(calls[0]?.headers.get("authorization"), "Bearer test-proxy-key-123456");
		assert.deepEqual(models.getModels("cliproxy").map((m) => m.id), entries.slice(0, 5).map((m) => m.id));
		const claude = models.getModel("cliproxy", "max-claude-sonnet-5-5")!;
		const codex = models.getModel("cliproxy", "codex/gpt-6.1-sol")!;
		const fallback = models.getModel("cliproxy", "unknown-chat")!;
		const nativeClaude = models.getModel("anthropic", "claude-sonnet-5-5")!;
		const nativeCodex = models.getModel("openai", "gpt-6.1-sol")!;
		const copilot = models.getModel("cliproxy", "copilot-claude-sonnet-5")!;
		assert.equal(copilot.api, "openai-completions");
		assert.equal(copilot.contextWindow, models.getModel("anthropic", "claude-sonnet-5")!.contextWindow);
		assert.equal(models.getModel("cliproxy", "openrouter/claude-sonnet-5")!.reasoning, true);
		for (const [proxied, native] of [[claude, nativeClaude], [codex, nativeCodex]] as const) {
			assert.equal(proxied.contextWindow, native.contextWindow);
			assert.equal(proxied.maxTokens, native.maxTokens);
			assert.equal(proxied.reasoning, native.reasoning);
			assert.deepEqual(proxied.input, native.input);
			assert.deepEqual(proxied.thinkingLevelMap, native.thinkingLevelMap);
			assert.deepEqual(proxied.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
		assert.equal(claude.api, "anthropic-messages");
		assert.equal(codex.api, "openai-completions");
		assert.deepEqual(fallback.input, ["text"]);
		assert.equal(fallback.reasoning, false);
		assert.equal(fallback.api, "openai-completions");
		assert.equal(piEngineForSpec({ provider: "cliproxy", id: claude.id, thinkingLevel: "low" }).level, "low");
		for (const [id, path, header] of [
			[claude.id, "/v1/messages", "x-api-key"],
			[codex.id, "/v1/chat/completions", "authorization"],
		] as const) {
			const engine = piEngineForSpec({ provider: "cliproxy", id, thinkingLevel: "low" });
			const result = await engine.streamFn(engine.model, normalizeContext({ systemPrompt: "Brief", messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }], timestamp: Date.now() }] }), { maxRetries: 0 }).result();
			assert.equal(result.stopReason, "error");
			const request = calls.at(-1)!;
			assert.equal(new URL(request.url).pathname, path);
			assert.equal(request.headers.get(header), header === "authorization" ? "Bearer test-proxy-key-123456" : "test-proxy-key-123456");
			assert.equal((await request.json()).model, id);
		}
	});

	it("keeps models out of picker and rejects streaming unless URL and key are both set", async () => {
		delete process.env.CLIPROXY_BASE_URL;
		delete process.env.CLIPROXY_API_KEY;
		for (const [url, key, ready] of [[undefined, undefined, false], [base, undefined, false], [undefined, "test-proxy-key-123456", false], ["not-a-url", "test-proxy-key-123456", false], [base, "test-proxy-key-123456", true]] as const) {
			if (url) process.env.CLIPROXY_BASE_URL = url;
			else delete process.env.CLIPROXY_BASE_URL;
			if (key) process.env.CLIPROXY_API_KEY = key;
			else delete process.env.CLIPROXY_API_KEY;
			assert.equal(providerKeyPresent("cliproxy"), ready);
			assert.equal(catalogProviders().find((p) => p.id === "cliproxy")?.keyPresent, ready);
			if (ready) assert.equal((await piModels().refresh({ providers: ["cliproxy"] })).errors.size, 0);
			assert.equal(modelCatalog().models.some((m) => m.provider === "cliproxy"), ready);
		}
		delete process.env.CLIPROXY_API_KEY;
		const engine = piEngineForSpec({ provider: "cliproxy", id: "codex/gpt-6.1-sol" });
		assert.equal((await engine.streamFn(engine.model, normalizeContext({ systemPrompt: "", messages: [] })).result()).stopReason, "error");
	});

	it("uses pi-ai's dynamic provider refresh to expose 401 without replacing a previous model list", async () => {
		process.env.CLIPROXY_API_KEY = "test-proxy-key-123456";
		const isolated = createModels();
		isolated.setProvider(cliProxyProvider(base));
		globalThis.fetch = async () => Response.json({ data: entries });
		assert.equal((await isolated.refresh({ providers: ["cliproxy"] })).errors.size, 0);
		const before = isolated.getModels("cliproxy");
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
		const result = await isolated.refresh({ providers: ["cliproxy"] });
		assert.match(result.errors.get("cliproxy")?.message ?? "", /401/);
		assert.deepEqual(isolated.getModels("cliproxy"), before);
	});
});
