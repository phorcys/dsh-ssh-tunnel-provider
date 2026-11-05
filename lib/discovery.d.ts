/**
 * `GET {basePath}/models` interrogation through the local forward.
 *
 * This is the same openai-compatible listing shape `dsh-llm-pi-ai` reads, but
 * the endpoint is the SSH-forwarded origin, so discovery needs the same
 * credential and headers as a model request. Parsing is deliberately tolerant:
 * sub2api installations front several upstreams, and their listings differ in
 * which capacity and modality fields they publish.
 *
 * @module dsh-llm-ssh-tunnel/discovery
 */
import type { ProviderModality } from './config.js';
/** One model the forwarded endpoint advertises. */
export interface DiscoveredModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: ProviderModality[];
}
/** Discovery request facts. */
export interface DiscoverModelsOptions {
    /** Forwarded origin plus API root, without a trailing slash. */
    baseUrl: string;
    /** Resolved bearer credential, when the route names one. */
    apiKey?: string;
    /** Deployment headers; attribution names win collisions. */
    headers: Readonly<Record<string, string>>;
    /** Caller cancellation. */
    signal?: AbortSignal;
    /** Total time allowed for the listing. */
    timeoutMs?: number;
}
/**
 * Parse a `/models` payload into deduplicated models in endpoint order.
 *
 * Accepts the standard `data` array, a bare array, a `models` array, and the
 * enriched `models` object several gateways use (the key is the request id
 * even when the entry names a different display id).
 * @param payload - decoded JSON response.
 * @returns models in endpoint order, deduplicated by id.
 */
export declare function parseModelList(payload: unknown): DiscoveredModel[];
/**
 * Interrogate the forwarded endpoint's model listing.
 * @param options - forwarded origin, credential, headers, and cancellation.
 * @returns advertised models in endpoint order.
 * @throws LlmError `AUTH` on a rejected credential, `DISCOVERY_FAILED` on transport/protocol failure.
 */
export declare function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]>;
