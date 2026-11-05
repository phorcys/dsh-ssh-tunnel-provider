/**
 * The live provider runtime: one SSH route whose connection facts, model
 * catalog, and retry/image knobs can be edited through the DSH settings page
 * without restarting the process.
 *
 * A settings write changes the Loader's volatile Config references and emits
 * `loader/volatile-update`. This runtime re-reads the Config, compares the
 * connection facts, and either restarts the forward or only rebuilds the model
 * catalog/profile. The adapter registration stays in place; `replace()` is
 * used only to refresh provider display metadata, never to tear the route down.
 *
 * @module dsh-llm-ssh-tunnel/runtime
 */
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { readConfig, resolveConfig } from './config.js';
import { SshPiAiAdapter } from './adapter.js';
import { resolveApiKey, resolveSecret } from './credentials.js';
import { discoverModels } from './discovery.js';
import { ModelCatalog, buildPiProvider } from './models.js';
import { mergePluginConfig } from './settings-store.js';
import { SshTunnel } from './tunnel.js';
/**
 * pi-ai's auth plane is inert here: this route authenticates only through the
 * key resolved per request by {@link TunnelProviderRuntime.resolveKey}, and
 * letting pi-ai's own store or ambient discovery manufacture a credential
 * would bill an unrelated tenant.
 */
const INERT_AUTH = {
    credentials: {
        async read() { return undefined; },
        async list() { return []; },
        async modify() {
            throw new Error('ssh-tunnel: this route has no pi-ai credential lifecycle');
        },
        async delete() { },
    },
    authContext: {
        async env() { return undefined; },
        async fileExists() { return false; },
    },
};
/** Sleep without keeping the process alive after the plugin is disposed. */
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
/** Render an unknown error for one log line. */
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Backoff after a failed catalog refresh, so a sleeping NAS is not hammered. */
const REFRESH_RETRY_MS = 30_000;
/** One SSH-tunnel provider route and its live settings. */
export class TunnelProviderRuntime {
    ctx;
    config;
    override;
    current;
    tunnel;
    catalog;
    adapter;
    registration;
    profile;
    profiles;
    disposed = false;
    updateListener;
    discoveryRun = 0;
    /**
     * Increments whenever a new forward replaces the previous one. A listing
     * read started against the old forward must not publish into the new one.
     */
    tunnelGeneration = 0;
    updateChain = Promise.resolve();
    /** When the last successful listing settled; undefined until the first one. */
    settledAt;
    /** Earliest time another automatic refresh may start after a failure. */
    nextAttemptAt = 0;
    /** Deduplicates concurrent refreshes; the listing read is shared. */
    inflightRefresh;
    /** Whether the last refresh failed, so a repeated failure logs once. */
    refreshFailing = false;
    /** Catalog signature currently published to the model picker. */
    publishedSignature;
    constructor(ctx, config, override) {
        this.ctx = ctx;
        this.config = config;
        this.override = override;
        this.current = resolveConfig(mergePluginConfig(readConfig(config), override));
        this.catalog = new ModelCatalog(this.current);
        this.tunnel = this.createTunnel();
        this.profile = this.buildProfile();
        this.profiles = new Map([[this.current.provider, this.profile]]);
        this.adapter = this.createAdapter();
    }
    /** Allocate the forward, register the route, and perform the first discovery. */
    async start() {
        await this.tunnel.allocate();
        try {
            this.registration = this.ctx.llm.registerAdapter([this.current.provider], this.adapter);
        }
        catch (error) {
            this.tunnel.stop();
            throw error;
        }
        this.tunnel.start();
        this.ctx.logger.info(`ssh-tunnel: provider "${this.current.provider}" registered (${this.current.displayName})`);
        this.updateListener = this.ctx.on('loader/volatile-update', () => { this.queueUpdate(); });
        await this.initialDiscovery();
    }
    /** Stop discovery, release the route, and close the current forward. */
    dispose() {
        this.disposed = true;
        this.discoveryRun += 1;
        this.updateListener?.();
        this.updateListener = undefined;
        this.registration?.();
        this.registration = undefined;
        this.tunnel.stop();
    }
    /** Build a new tunnel generation from the current resolved Config. */
    createTunnel() {
        return new SshTunnel(this.current, this.ctx.logger, ref => resolveSecret(this.ctx, ref, 'SSH credential'));
    }
    /** Build the pi-ai provider/profile for the current Config and tunnel generation. */
    buildProfile() {
        const provider = buildPiProvider({
            provider: this.current.provider,
            displayName: this.current.displayName,
            baseUrl: () => this.tunnel.baseUrl,
            catalog: this.catalog,
        });
        return {
            provider: this.current.provider,
            displayName: this.current.displayName,
            streamIdleTimeoutMs: this.current.streamIdleTimeoutMs,
            maxRequestImageBytes: this.current.maxRequestImageBytes,
            requestImagePixelBudget: this.current.requestImagePixelBudget,
            requestImageMaxBytes: this.current.requestImageMaxBytes,
            retryPolicy: resolveRetryPolicy(this.current.retryPolicy, `ssh-tunnel provider "${this.current.provider}" retryPolicy`),
            configuredMaxTokens: this.catalog.configuredMaxTokens(),
            modelErrors: new Map(),
            piProvider: provider,
            headers: { ...this.current.headers },
            ...this.current.reasoning === undefined ? {} : { reasoning: this.current.reasoning },
        };
    }
    /** Build the one adapter installed for this route. */
    createAdapter() {
        return new SshPiAiAdapter({
            profiles: () => this.profiles,
            resolveApiKey: async () => await resolveApiKey(this.ctx, this.current.apiKeyEnv),
            auth: INERT_AUTH,
            getTunnel: () => this.tunnel,
            getRequestTimeoutMs: () => this.current.requestTimeoutMs,
            onCatalogAccess: () => this.noteCatalogAccess(),
            resolveAttachments: () => this.ctx.get('attachments'),
            resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => this.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
            onReplayDegrade: ({ provider, model, reason }) => {
                this.ctx.logger.warn(`ssh-tunnel: unusable replay state on ${provider}/${model}; sending provider-neutral history (${reason})`);
            },
        });
    }
    /** Publish a new profile snapshot; the adapter's `profiles` closure reads it. */
    publishProfile() {
        this.publishedSignature = this.catalog.signature();
        this.profile = this.buildProfile();
        this.profiles = new Map([[this.current.provider, this.profile]]);
        this.registration?.replace([this.current.provider]);
        this.ctx.emit('llm/adapters-updated');
    }
    /**
     * First listing. It blocks boot only while the configured catalog is empty,
     * because a one-shot headless task must be able to name a discovered model.
     * With a configured catalog, discovery is enrichment and stays in the
     * background.
     */
    async initialDiscovery() {
        if (!this.current.discoverModels)
            return;
        if (this.current.models.length > 0) {
            void this.refreshModels().catch(() => {
                // Logged by `runRefresh`; the configured catalog keeps serving.
            });
            return;
        }
        try {
            await this.runRefresh(this.current.startupTimeoutMs);
            return;
        }
        catch (error) {
            if (!this.disposed) {
                this.ctx.logger.warn(`ssh-tunnel: initial model discovery deferred: ${errorText(error)}`);
            }
        }
        void this.discoverLoop();
    }
    /**
     * Retry discovery until one listing succeeds, the runtime is disposed, or a
     * newer run supersedes this one. Used only before the first successful
     * listing; afterwards {@link noteCatalogAccess} owns refreshes.
     */
    async discoverLoop() {
        const run = ++this.discoveryRun;
        while (!this.disposed && run === this.discoveryRun) {
            try {
                await this.runRefresh();
                if (this.disposed || run !== this.discoveryRun)
                    return;
                return;
            }
            catch (error) {
                if (this.disposed || run !== this.discoveryRun)
                    return;
                this.ctx.logger.warn(`ssh-tunnel: model discovery deferred: ${errorText(error)}`);
            }
            await delay(30_000);
        }
    }
    /**
     * Read the forwarded model listing and publish it when the catalog changed.
     *
     * A listing identical to the one already published is not republished: every
     * publish announces `llm/adapters-updated`, and an unchanged catalog would
     * make every picker re-read for nothing.
     * @param timeoutMs - budget for the tunnel and the listing request.
     * @returns the number of models the endpoint advertised.
     */
    async refreshCatalog(timeoutMs, generation) {
        const tunnel = this.tunnel;
        await tunnel.ensureReady(timeoutMs);
        const apiKey = await resolveApiKey(this.ctx, this.current.apiKeyEnv);
        const models = await discoverModels({
            baseUrl: tunnel.baseUrl,
            ...apiKey === undefined ? {} : { apiKey },
            headers: this.current.headers,
            timeoutMs: Math.max(5_000, timeoutMs),
        });
        if (this.disposed || tunnel !== this.tunnel || generation !== this.tunnelGeneration) {
            throw new Error('ssh-tunnel: the forward changed while the model listing was in flight');
        }
        this.catalog.update(this.current);
        const dropped = this.catalog.setDiscovered(models);
        if (dropped.length > 0) {
            this.ctx.logger.info(`ssh-tunnel: skipped ${dropped.length} unservable, retired, or duplicate model(s)`
                + ` (${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ', …' : ''})`);
        }
        if (this.catalog.signature() !== this.publishedSignature)
            this.publishProfile();
        return models.length;
    }
    /**
     * Refresh the model listing now, sharing one in-flight read.
     * @returns the number of models the endpoint advertised.
     * @throws LlmError from discovery; the caller decides whether to surface it.
     */
    async refreshModels() {
        if (this.disposed)
            return 0;
        if (this.inflightRefresh !== undefined)
            return await this.inflightRefresh;
        const run = this.runRefresh();
        this.inflightRefresh = run;
        try {
            return await run;
        }
        finally {
            if (this.inflightRefresh === run)
                this.inflightRefresh = undefined;
        }
    }
    /** One refresh attempt, recording when the listing settled and backing off on failure. */
    async runRefresh(timeoutMs = this.current.requestTimeoutMs) {
        const generation = this.tunnelGeneration;
        try {
            const count = await this.refreshCatalog(timeoutMs, generation);
            if (this.disposed || generation !== this.tunnelGeneration)
                return 0;
            this.settledAt = Date.now();
            this.nextAttemptAt = 0;
            // A success also retires any retry loop started before the first
            // listing; the TTL path owns refreshes from here.
            this.discoveryRun += 1;
            if (this.refreshFailing) {
                this.refreshFailing = false;
                this.ctx.logger.info('ssh-tunnel: model listing recovered');
            }
            this.ctx.logger.info(`ssh-tunnel: model listing refreshed (${count} model(s) advertised)`);
            this.reportFacts();
            return count;
        }
        catch (error) {
            if (this.disposed || generation !== this.tunnelGeneration)
                throw error;
            this.nextAttemptAt = Date.now() + REFRESH_RETRY_MS;
            if (!this.refreshFailing) {
                this.refreshFailing = true;
                this.ctx.logger.warn(`ssh-tunnel: model listing refresh failed: ${errorText(error)}`);
            }
            throw error;
        }
    }
    /**
     * Answer a catalog read: refresh a stale listing in the background.
     *
     * This is what makes a sub2api-side model addition reach DSH without a
     * restart: reopening the model picker reads `listModels()`, this notices the
     * listing is older than `modelsMaxAgeMs`, and the fresh catalog is announced
     * with `llm/adapters-updated`.
     */
    noteCatalogAccess() {
        if (this.disposed || !this.current.discoverModels)
            return;
        if (this.current.modelsMaxAgeMs < 0)
            return;
        const now = Date.now();
        if (now < this.nextAttemptAt)
            return;
        if (this.settledAt !== undefined && now - this.settledAt < this.current.modelsMaxAgeMs)
            return;
        void this.refreshModels().catch(() => {
            // `runRefresh` already logged and backed off.
        });
    }
    /**
     * Say how many models were sized from built-in facts and which still rest on
     * route defaults. sub2api's listing carries no capacities, so a fallback
     * model is a guess the deployment should correct.
     */
    reportFacts() {
        const summary = this.catalog.summary();
        if (summary.known > 0 || summary.discovery > 0) {
            this.ctx.logger.info(`ssh-tunnel: model facts — ${summary.config} configured, ${summary.discovery} from the endpoint,`
                + ` ${summary.known} from built-in families`);
        }
        if (summary.fallback.length === 0)
            return;
        const sample = summary.fallback.slice(0, 5).join(', ');
        const more = summary.fallback.length > 5 ? `, +${summary.fallback.length - 5} more` : '';
        this.ctx.logger.warn(`ssh-tunnel: ${summary.fallback.length} model(s) use route defaults`
            + ` (${this.current.defaults.contextWindow} context / ${this.current.defaults.maxTokens} output):`
            + ` ${sample}${more} — declare them under "models" if those capacities are wrong`);
    }
    /** Listing facts for the settings card. */
    catalogSnapshot() {
        const summary = this.catalog.summary();
        return {
            models: summary.total,
            ...this.settledAt === undefined ? {} : { refreshedAt: this.settledAt },
            maxAgeMs: this.current.modelsMaxAgeMs,
            builtin: summary.known + summary.discovery,
            fallback: summary.fallback.length,
        };
    }
    /** The browser card's view of the current connection facts. */
    settingsSnapshot() {
        return {
            ssh: {
                host: this.current.ssh.host,
                port: this.current.ssh.port,
                ...this.current.ssh.user === undefined ? {} : { user: this.current.ssh.user },
                ...this.current.ssh.identityFile === undefined ? {} : { identityFile: this.current.ssh.identityFile },
                ...this.current.ssh.knownHostsFile === undefined ? {} : { knownHostsFile: this.current.ssh.knownHostsFile },
                strictHostKeyChecking: this.current.ssh.strictHostKeyChecking,
            },
            remote: {
                host: this.current.remote.host,
                port: this.current.remote.port,
                basePath: this.current.remote.basePath,
            },
            ...this.current.apiKeyEnv === undefined ? {} : { apiKeyEnv: this.current.apiKeyEnv },
            api: this.current.api,
        };
    }
    /**
     * Apply one browser-card settings write. Validation happens before the
     * override is installed, so a bad edit leaves the serving route untouched.
     * @param patch - connection facts from the settings route.
     */
    async applySettings(patch) {
        const merged = mergePluginConfig(readConfig(this.config), patch);
        resolveConfig(merged);
        this.override = patch;
        const run = this.updateChain.then(() => this.applyUpdate(), () => this.applyUpdate());
        this.updateChain = run.catch(() => { });
        await run;
    }
    /** Serialize settings-driven updates so two quick saves cannot race a restart. */
    queueUpdate() {
        this.updateChain = this.updateChain.then(() => this.applyUpdate(), () => this.applyUpdate()).catch((error) => {
            this.ctx.logger.error(`ssh-tunnel: could not apply settings update: ${errorText(error)}`);
        });
    }
    /** Re-read volatile Config and apply the smallest necessary change. */
    async applyUpdate() {
        if (this.disposed)
            return;
        const next = resolveConfig(mergePluginConfig(readConfig(this.config), this.override));
        if (next.provider !== this.current.provider) {
            this.ctx.logger.warn(`ssh-tunnel: provider key "${this.current.provider}" is fixed at mount;`
                + ` change "${next.provider}" in the profile and restart DSH`);
            return;
        }
        const connectionChanged = JSON.stringify(next.ssh) !== JSON.stringify(this.current.ssh)
            || JSON.stringify(next.remote) !== JSON.stringify(this.current.remote)
            || next.localPort !== this.current.localPort;
        if (connectionChanged) {
            // Invalidate any in-flight listing before the forward changes: it belongs
            // to the old endpoint and must neither publish nor satisfy a refresh for
            // the new one. Clearing the discovery half prevents stale model ids from
            // surviving a move to a different sub2api.
            this.tunnelGeneration += 1;
            this.inflightRefresh = undefined;
            this.settledAt = undefined;
            this.nextAttemptAt = 0;
            this.catalog.clearDiscovered();
            this.discoveryRun += 1;
        }
        this.current = next;
        this.catalog.update(next);
        // Disabling discovery means the configured catalog is the whole catalog;
        // old discovered ids must not survive the switch.
        if (!next.discoverModels)
            this.catalog.clearDiscovered();
        if (connectionChanged) {
            const previous = this.tunnel;
            this.tunnel = this.createTunnel();
            previous.stop();
            await this.tunnel.allocate();
            this.tunnel.start();
        }
        this.publishProfile();
        // A saved card may point at a different endpoint, key, or header set, and
        // the model list is a property of that endpoint. With discovery on, always
        // re-read it; without discovery, only the configured catalog should serve.
        if (next.discoverModels) {
            this.nextAttemptAt = 0;
            void this.refreshModels().catch(() => {
                // Logged by `runRefresh`; the configured catalog keeps serving.
            });
            // With no configured catalog, a failed refresh would leave the picker
            // empty until something else reads it; keep the boot retry loop alive.
            if (next.models.length === 0)
                void this.discoverLoop();
            return;
        }
        // Discovery is off: the configured catalog is final. Never run the retry
        // loop here, or a settings save would quietly reintroduce discovered ids.
    }
}
