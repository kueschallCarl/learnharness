import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data: pi-ai's configured providers plus CLIProxyAPI's
 * live catalog. A failed proxy refresh is a 503, not a silently stale list.
 */
export async function GET() {
	try { await refreshConnectionCatalog(); }
	catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "CLIProxyAPI model list failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
	}
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
