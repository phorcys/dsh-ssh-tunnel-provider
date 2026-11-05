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
import { LlmError } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
/** pi-ai adapter that gates each request on tunnel readiness. */
export class SshPiAiAdapter extends PiAiAdapter {
    getTunnel;
    getRequestTimeoutMs;
    onCatalogAccess;
    constructor(options) {
        super(options);
        this.getTunnel = options.getTunnel;
        this.getRequestTimeoutMs = options.getRequestTimeoutMs;
        this.onCatalogAccess = options.onCatalogAccess;
    }
    /**
     * List models, first letting the runtime refresh a stale listing.
     *
     * The picker reads this whenever it reopens and whenever the Host announces
     * an adapter change, so this is the natural place for a TTL refresh: the
     * read itself is never delayed, and the fresh catalog arrives through the
     * same `llm/adapters-updated` announcement that announced the route.
     */
    async listModels(provider) {
        this.onCatalogAccess?.();
        return await super.listModels(provider);
    }
    /** Wait for the forward, translating cancellation into the seam's code. */
    async awaitTunnel(signal) {
        try {
            await this.getTunnel().ensureReady(this.getRequestTimeoutMs(), signal);
        }
        catch (error) {
            if (signal?.aborted) {
                throw new LlmError('ssh-tunnel: request aborted while waiting for the SSH forward', 'ABORTED', { cause: error });
            }
            throw error;
        }
    }
    async *stream(options) {
        await this.awaitTunnel(options.signal);
        yield* super.stream(options);
    }
    async prepareCall(provider, model, signal) {
        // `PiAiAdapter.prepareCall` freezes the model descriptor (including its
        // loopback base URL) for the step. Waiting here means that snapshot is
        // taken against a forward that can serve it.
        await this.awaitTunnel(signal);
        const prepared = await super.prepareCall(provider, model, signal);
        return {
            model: prepared.model,
            stream: options => this.streamPrepared(prepared, options),
        };
    }
    /** The prepared dispatch, with the tunnel gate in front of the frozen snapshot. */
    async *streamPrepared(prepared, options) {
        await this.awaitTunnel(options.signal);
        yield* prepared.stream(options);
    }
}
