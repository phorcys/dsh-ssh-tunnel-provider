/**
 * The route's model catalog and pi-ai descriptors.
 *
 * The catalog has two sources: models written in the profile, and models the
 * forwarded `/models` listing advertised. Configured entries always win on a
 * shared id, so a user can correct a discovered capacity without restating
 * the whole catalog. Descriptors are rebuilt on every `getModels()` call
 * because the tunnel may rebind its loopback port after a reconnect.
 *
 * @module dsh-llm-ssh-tunnel/models
 */
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import type { DiscoveredModel } from './discovery.js';
import type { ProviderApi, ProviderModality, ResolvedConfig, ThinkingLevel } from './config.js';
/** Where one model's capability facts came from. */
export type FactSource = 'config' | 'discovery' | 'known' | 'defaults';
/** One model after profile defaults and discovery metadata are merged. */
export interface ResolvedModel {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    input: readonly ProviderModality[];
    reasoningEfforts?: false | Record<string, string | null>;
    compat?: Readonly<Record<string, unknown>>;
    /** The explicitly configured output cap, which also becomes the request default. */
    explicitMaxTokens?: number;
    /** Where capacity and modality facts came from, for diagnostics. */
    source: FactSource;
    /** Matched built-in family, when one applied. */
    family?: string;
    /** Wire protocol this model speaks. */
    api: ProviderApi;
}
/** Turn configured reasoning levels into pi-ai's capability fields. */
export declare function reasoningFields(efforts: false | Record<string, string | null> | undefined): Pick<Model<Api>, 'reasoning' | 'thinkingLevelMap'>;
/**
 * The base URL one protocol expects, derived from the configured API root.
 *
 * The OpenAI SDKs treat the base URL as the prefix they append their own path
 * to, so `openai-completions` and `openai-responses` want the `/v1` root. The
 * Anthropic SDK appends `/v1/messages` itself, so it wants the server root —
 * feeding it `/v1` produces `/v1/v1/messages`, which sub2api answers with 404.
 * @param apiRoot - forwarded origin plus the configured `remote.basePath`.
 * @param api - protocol the model speaks.
 * @returns the base URL that protocol expects.
 */
export declare function protocolBaseUrl(apiRoot: string, api: ProviderApi): string;
/** The live catalog for one route. */
export declare class ModelCatalog {
    private config;
    private discovered;
    constructor(config: ResolvedConfig);
    /** Replace the profile facts after a live settings edit. */
    update(config: ResolvedConfig): void;
    /** Drop the discovered half; used when discovery is disabled or the endpoint changes. */
    clearDiscovered(): void;
    /**
     * Replace the discovered half of the catalog, dropping models this route
     * cannot serve (image generation, embeddings, speech).
     * @param models - ids the endpoint advertised.
     * @returns the ids that were dropped for not being chat models.
     */
    setDiscovered(models: readonly DiscoveredModel[]): readonly string[];
    /** Current models: configured entries first, then new discovered ids. */
    models(): ResolvedModel[];
    /**
     * Count models by the layer that supplied their capability facts.
     * @returns totals plus the ids that still rest on route defaults.
     */
    summary(): {
        total: number;
        config: number;
        discovery: number;
        known: number;
        fallback: readonly string[];
    };
    /**
     * Stable text of the effective catalog, so a refresh publishes only when it
     * changed. Model order is significant: reordering the profile is a change.
     * @returns a signature whose inequality means the picker must re-read.
     */
    signature(): string;
    /**
     * Output caps explicitly configured by the profile, by model id.
     *
     * The cap is computed from the fully resolved model, not the route default,
     * so a configured `maxTokens` is not clamped to 262k when the model's real
     * window comes from a built-in family or discovery metadata.
     */
    configuredMaxTokens(): ReadonlyMap<string, number>;
    /** Build pi-ai model descriptors against the tunnel's current origin. */
    piModels(provider: string, apiRoot: string): Model<Api>[];
    /** The profile's default reasoning level, when configured. */
    defaultReasoning(): ThinkingLevel | undefined;
}
/** Build the pi-ai provider whose `getModels()` always reads the live catalog. */
export declare function buildPiProvider(options: {
    provider: string;
    displayName: string;
    /** The forwarded origin plus the configured API root, read per call. */
    baseUrl: () => string;
    catalog: ModelCatalog;
}): Provider;
