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
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
import type { SettingsPatch } from './settings-store.js';
/** One SSH-tunnel provider route and its live settings. */
export declare class TunnelProviderRuntime {
    private readonly ctx;
    private readonly config;
    private override;
    private current;
    private tunnel;
    private readonly catalog;
    private adapter;
    private registration;
    private profile;
    private profiles;
    private disposed;
    private updateListener;
    private discoveryRun;
    /**
     * Increments whenever a new forward replaces the previous one. A listing
     * read started against the old forward must not publish into the new one.
     */
    private tunnelGeneration;
    private updateChain;
    /** When the last successful listing settled; undefined until the first one. */
    private settledAt;
    /** Earliest time another automatic refresh may start after a failure. */
    private nextAttemptAt;
    /** Deduplicates concurrent refreshes; the listing read is shared. */
    private inflightRefresh;
    /** Whether the last refresh failed, so a repeated failure logs once. */
    private refreshFailing;
    /** Catalog signature currently published to the model picker. */
    private publishedSignature;
    constructor(ctx: Context, config: PluginConfig, override?: SettingsPatch);
    /** Allocate the forward, register the route, and perform the first discovery. */
    start(): Promise<void>;
    /** Stop discovery, release the route, and close the current forward. */
    dispose(): void;
    /** Build a new tunnel generation from the current resolved Config. */
    private createTunnel;
    /** Build the pi-ai provider/profile for the current Config and tunnel generation. */
    private buildProfile;
    /** Build the one adapter installed for this route. */
    private createAdapter;
    /** Publish a new profile snapshot; the adapter's `profiles` closure reads it. */
    private publishProfile;
    /**
     * First listing. It blocks boot only while the configured catalog is empty,
     * because a one-shot headless task must be able to name a discovered model.
     * With a configured catalog, discovery is enrichment and stays in the
     * background.
     */
    private initialDiscovery;
    /**
     * Retry discovery until one listing succeeds, the runtime is disposed, or a
     * newer run supersedes this one. Used only before the first successful
     * listing; afterwards {@link noteCatalogAccess} owns refreshes.
     */
    private discoverLoop;
    /**
     * Read the forwarded model listing and publish it when the catalog changed.
     *
     * A listing identical to the one already published is not republished: every
     * publish announces `llm/adapters-updated`, and an unchanged catalog would
     * make every picker re-read for nothing.
     * @param timeoutMs - budget for the tunnel and the listing request.
     * @returns the number of models the endpoint advertised.
     */
    private refreshCatalog;
    /**
     * Refresh the model listing now, sharing one in-flight read.
     * @returns the number of models the endpoint advertised.
     * @throws LlmError from discovery; the caller decides whether to surface it.
     */
    refreshModels(): Promise<number>;
    /** One refresh attempt, recording when the listing settled and backing off on failure. */
    private runRefresh;
    /**
     * Answer a catalog read: refresh a stale listing in the background.
     *
     * This is what makes a sub2api-side model addition reach DSH without a
     * restart: reopening the model picker reads `listModels()`, this notices the
     * listing is older than `modelsMaxAgeMs`, and the fresh catalog is announced
     * with `llm/adapters-updated`.
     */
    private noteCatalogAccess;
    /**
     * Say how many models were sized from built-in facts and which still rest on
     * route defaults. sub2api's listing carries no capacities, so a fallback
     * model is a guess the deployment should correct.
     */
    private reportFacts;
    /** Listing facts for the settings card. */
    catalogSnapshot(): {
        models: number;
        refreshedAt?: number;
        maxAgeMs: number;
        builtin: number;
        fallback: number;
    };
    /** The browser card's view of the current connection facts. */
    settingsSnapshot(): {
        ssh: {
            host: string;
            port: number;
            user?: string;
            identityFile?: string;
            knownHostsFile?: string;
            strictHostKeyChecking: 'yes' | 'no' | 'accept-new';
        };
        remote: {
            host: string;
            port: number;
            basePath: string;
        };
        apiKeyEnv?: string;
        api: string;
    };
    /**
     * Apply one browser-card settings write. Validation happens before the
     * override is installed, so a bad edit leaves the serving route untouched.
     * @param patch - connection facts from the settings route.
     */
    applySettings(patch: SettingsPatch): Promise<void>;
    /** Serialize settings-driven updates so two quick saves cannot race a restart. */
    private queueUpdate;
    /** Re-read volatile Config and apply the smallest necessary change. */
    private applyUpdate;
}
