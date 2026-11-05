/**
 * `PiAiAdapter` with one added obligation: a model request does not start
 * until the SSH forward that carries it is accepting connections.
 *
 * Everything else — message conversion, images, tools, replay, reasoning,
 * usage, retries — stays in `@deepseek-ai/dsh-llm-pi-ai`, the same public
 * adapter WorkBuddy and other provider bundles build on. `prepareCall` is
 * wrapped too: the agent loop takes that path, and its returned `stream` is
 * otherwise the base class's private snapshot dispatcher, which would bypass
 * a tunnel wait added only to `stream()`.
 *
 * @module dsh-llm-ssh-tunnel/adapter
 */
import type { GenerateOptions, LlmModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai';
/** The tunnel surface the adapter depends on. */
export interface AdapterTunnel {
    ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<void>;
}
/** Constructor options for {@link SshPiAiAdapter}. */
export interface SshPiAiAdapterOptions extends PiAiAdapterOptions {
    /** The forward generation currently serving this route. */
    getTunnel: () => AdapterTunnel;
    /** The current request-level wait, re-read after a live settings edit. */
    getRequestTimeoutMs: () => number;
    /**
     * Notified before a catalog read. The runtime answers "is the listing
     * stale?" and refreshes it in the background, which is the same
     * access-driven staleness DSH's own DeepSeek adapter implements.
     */
    onCatalogAccess?: () => void;
}
/** pi-ai adapter that gates each request on tunnel readiness. */
export declare class SshPiAiAdapter extends PiAiAdapter {
    private readonly getTunnel;
    private readonly getRequestTimeoutMs;
    private readonly onCatalogAccess;
    constructor(options: SshPiAiAdapterOptions);
    /**
     * List models, first letting the runtime refresh a stale listing.
     *
     * The picker reads this whenever it reopens and whenever the Host announces
     * an adapter change, so this is the natural place for a TTL refresh: the
     * read itself is never delayed, and the fresh catalog arrives through the
     * same `llm/adapters-updated` announcement that announced the route.
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** Wait for the forward, translating cancellation into the seam's code. */
    private awaitTunnel;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    /** The prepared dispatch, with the tunnel gate in front of the frozen snapshot. */
    private streamPrepared;
}
