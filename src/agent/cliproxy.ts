import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const anthropic = new Map(anthropicProvider().getModels().map((model) => [model.id, model]));
const openai = new Map(openaiProvider().getModels().map((model) => [model.id, model]));

function chatModel(id: string, owner: string, base: string): Model<"anthropic-messages" | "openai-completions"> {
	const isAnthropic = owner === "anthropic";
	const api = isAnthropic ? "anthropic-messages" : "openai-completions";
	const strippedId = id.replace(/^(?:(?:max-|copilot-|codex\/|openrouter\/|bedrock\/))+/i, "");
	// Copilot writes versions with dots (claude-opus-5.5); pi-ai's catalogs use dashes.
	const lookup = (catalog: Map<string, Model<any>>) => catalog.get(strippedId) ?? catalog.get(strippedId.replace(/\./g, "-"));
	const native = isAnthropic ? lookup(anthropic) ?? lookup(openai) : lookup(openai) ?? lookup(anthropic);
	return {
		id,
		name: id,
		provider: "cliproxy",
		api,
		baseUrl: isAnthropic ? base : `${base}/v1`,
		input: native ? [...native.input] : ["text"],
		reasoning: native?.reasoning ?? false,
		// Unknown ids (older or third-party models): sizes every current chat
		// model supports. A tiny window here made the session compact on every
		// turn and cut replies short.
		contextWindow: native?.contextWindow ?? 128_000,
		maxTokens: native?.maxTokens ?? 16_384,
		...(native?.inputLimits ? { inputLimits: native.inputLimits } : {}),
		...(native?.thinkingLevelMap ? { thinkingLevelMap: native.thinkingLevelMap } : {}),
		// Shared compat flags still apply if the native OpenAI entry uses
		// Responses; pi-ai fills chat-completions-only defaults itself.
		...(native?.compat ? { compat: native.compat } : {}),
		cost: FREE,
	};
}

export function cliProxyProvider(base: string) {
	return createProvider({
		id: "cliproxy",
		name: "CLIProxyAPI",
		baseUrl: base,
		auth: { apiKey: envApiKeyAuth("CLIProxyAPI key", ["CLIPROXY_API_KEY"]) },
		models: [],
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
		fetchModels: async ({ credential, signal }) => {
			const key = credential?.type === "api_key" ? credential.key : undefined;
			if (!key) throw new Error("CLIProxyAPI key is not configured");
			const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal });
			if (!response.ok) throw new Error(`CLIProxyAPI model list failed (${response.status})`);
			const payload: unknown = await response.json();
			if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) throw new Error("Invalid CLIProxyAPI model list");
			const models: Model<"anthropic-messages" | "openai-completions">[] = [];
			const ids = new Set<string>();
			for (const entry of payload.data) {
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || typeof entry.owned_by !== "string" || /image|embed|whisper|transcrib|tts|moderation|rerank|video/i.test(entry.id) || ["image", "classifier", "embedding", "audio", "video", "reranker"].includes(entry.type) || ids.has(entry.id)) continue;
				ids.add(entry.id);
				models.push(chatModel(entry.id, entry.owned_by, base));
			}
			return models;
		},
	});
}
