/**
 * Configuration schema and normalization for the SSH-tunnel provider.
 *
 * The schema is intentionally close to `@deepseek-ai/dsh-llm-pi-ai`'s
 * hand-declared gateway profile: SSH connection facts replace that profile's
 * `baseURL`, while credentials, headers, model metadata, and compatibility
 * switches keep the same vocabulary. Normalization validates the parts SSH
 * cannot: route names, ports, paths, duplicate model ids, and the "no models
 * and no discovery" dead end.
 *
 * @module dsh-llm-ssh-tunnel/config
 */
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
/** Modalities this provider can declare for one model. */
export type ProviderModality = 'text' | 'image';
/**
 * Wire protocols a sub2api deployment serves.
 *
 * One deployment answers all three: `POST /v1/chat/completions`,
 * `POST /v1/responses`, and `POST /v1/messages`. They differ in what the
 * gateway does with reasoning and tools, and in measured latency, so the
 * protocol is a per-model choice rather than a build-time decision.
 */
export declare const PROVIDER_APIS: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
/** One wire protocol this provider can speak. */
export type ProviderApi = (typeof PROVIDER_APIS)[number];
/** Default protocol for a model that names none. */
export declare const DEFAULT_PROVIDER_API: ProviderApi;
/** Reasoning levels pi-ai understands, in its display order. */
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** One pi-ai thinking level. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** Default route name when the configuration does not name one. */
export declare const DEFAULT_PROVIDER = "sub2api-ssh";
/** Default remote loopback host: sub2api usually listens on the NAS itself. */
export declare const DEFAULT_REMOTE_HOST = "127.0.0.1";
/** Default sub2api port. */
export declare const DEFAULT_REMOTE_PORT = 8080;
/** Default API root under the forwarded origin. */
export declare const DEFAULT_BASE_PATH = "/v1";
/**
 * Compatibility switches a sub2api deployment normally needs.
 *
 * pi-ai detects compatibility from the endpoint URL, and after SSH the URL is
 * `127.0.0.1:<random>`, which tells it nothing. These are the switches the
 * known-working sub2api profile uses: OpenAI-style reasoning effort, no
 * developer role, and `max_tokens` as the output cap. Every one is overridable.
 */
export declare const DEFAULT_COMPAT: Readonly<Record<string, unknown>>;
/** Default model context capacity when neither configuration nor discovery sizes it. */
export declare const DEFAULT_CONTEXT_WINDOW = 262144;
/** Default per-model output capability when neither configuration nor discovery sizes it. */
export declare const DEFAULT_MAX_TOKENS = 32768;
/** Default request-level wait for an SSH tunnel that is still connecting. */
export declare const DEFAULT_REQUEST_TIMEOUT_SECONDS = 20;
/** Default boot-time wait for the first model discovery when no catalog was written. */
export declare const DEFAULT_STARTUP_TIMEOUT_SECONDS = 8;
/**
 * Default model-listing age after which the next catalog read refreshes it.
 *
 * DSH's own DeepSeek adapter uses the same ten-minute window: a stale listing
 * is re-read in the background instead of blocking the reader, and the result
 * is published only when the catalog actually changed.
 */
export declare const DEFAULT_MODELS_MAX_AGE_MS = 600000;
/** Default idle ceiling while one upstream stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default accumulated base64 image payload bound. */
export declare const DEFAULT_MAX_REQUEST_IMAGE_BYTES: number;
/** Default total-pixel budget for one request image. */
export declare const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET: number;
/** Default raw encoded-byte target for one request image. */
export declare const DEFAULT_REQUEST_IMAGE_MAX_BYTES: number;
/** SSH transport settings understood by the in-process ssh2 client. */
export interface SshConfig {
    /** SSH destination: hostname or IP. */
    host: string;
    /** SSH port; defaults to 22. */
    port?: number;
    /** SSH user; defaults to the DSH process user. */
    user?: string;
    /** Private key path; `~` is expanded. Omit to use an ssh-agent. */
    identityFile?: string;
    /** Alias for {@link identityFile}. */
    key?: string;
    /** Credential reference containing the private-key passphrase. */
    passphraseEnv?: string;
    /** Credential reference containing the SSH password (key auth is preferred). */
    passwordEnv?: string;
    /** ssh-agent socket path, `pageant`, or `true` to infer one. */
    agent?: boolean | string;
    /** Alternate known_hosts file; defaults to `~/.ssh/known_hosts`. */
    knownHostsFile?: string;
    /** Host-key policy. `accept-new` trusts an unknown host once and pins it. */
    strictHostKeyChecking?: 'yes' | 'no' | 'accept-new';
}
/** Where sub2api listens on the far side of the SSH connection. */
export interface RemoteConfig {
    /** Host as resolved by the NAS; loopback unless sub2api binds elsewhere. */
    host?: string;
    /** sub2api HTTP port on the NAS. */
    port: number;
    /** API root, e.g. `/v1`; empty forwards the origin unchanged. */
    basePath?: string;
}
/** One model the route advertises. */
export interface ModelConfig {
    /** Model id sent upstream and selected in DSH. */
    id: string;
    /** Wire protocol for this model; defaults to the route `api`. */
    api?: ProviderApi;
    /** Display name; defaults to {@link id}. */
    name?: string;
    /** Maximum combined request and response context. */
    contextWindow?: number;
    /** Maximum output tokens; also becomes the request default for this model. */
    maxTokens?: number;
    /** Accepted request modalities; defaults to text only. */
    input?: ProviderModality[];
    /**
     * Offered reasoning levels, keyed by level and mapped to the wire spelling.
     * `false` declares a non-reasoning model; omission also declares none.
     */
    reasoningEfforts?: false | Record<string, string | null>;
    /** pi-ai OpenAI-completions compatibility overrides for this model. */
    compat?: Record<string, unknown>;
}
/** Values applied to models that do not size themselves. */
export interface DefaultsConfig {
    /** Wire protocol for models that do not name one. */
    api?: ProviderApi;
    contextWindow?: number;
    maxTokens?: number;
    input?: ProviderModality[];
    reasoningEfforts?: false | Record<string, string | null>;
    compat?: Record<string, unknown>;
}
/** The plugin's YAML configuration. */
export interface PluginConfig {
    /** Route key used by `GenerateOptions.provider`; stable across restarts. */
    provider?: string;
    /** Display name in selectors and diagnostics. */
    displayName?: string;
    /** SSH connection facts. */
    ssh: SshConfig;
    /** Forward destination on the NAS. */
    remote: RemoteConfig;
    /** Local loopback port; `0` (the default) picks a free one. */
    localPort?: number;
    /** Credential reference resolved through the harness credential seam. */
    apiKeyEnv?: string;
    /**
     * Wire protocol for every model that does not override it. sub2api serves
     * `openai-completions`, `openai-responses`, and `anthropic-messages`; the
     * Responses route is measurably faster on DeepSeek deployments.
     */
    api?: ProviderApi;
    /** Extra HTTP headers for model and discovery requests. */
    headers?: Record<string, string>;
    /** Route-wide OpenAI-completions compatibility switches. */
    compat?: Record<string, unknown>;
    /** Configured model catalog. Omit to rely on `/models` discovery. */
    models?: ModelConfig[];
    /** Defaults for configured and discovered models. */
    defaults?: DefaultsConfig;
    /** Query `GET {basePath}/models` through the tunnel. Defaults to true without models. */
    discoverModels?: boolean;
    /**
     * Supply capability facts for well-known model families when the endpoint
     * publishes none. sub2api's listing carries only ids, so without this a
     * 1M-context model is sized from `defaults`. A configured `models` entry
     * still wins. Defaults to true.
     */
    knownModels?: boolean;
    /** Default reasoning level materialized when a caller omits one. */
    reasoning?: ThinkingLevel;
    /** Provider-owned retry policy. */
    retryPolicy?: RetryPolicyConfig;
    /** Provider idle ceiling while one stream read is outstanding. */
    streamIdleTimeoutMs?: number;
    /** How long one request waits for a tunnel that is still connecting. */
    requestTimeoutSeconds?: number;
    /** How long boot waits for the first model listing; discovery continues in the background after this. */
    startupTimeoutSeconds?: number;
    /**
     * Age after which the next catalog read refreshes the listing in the
     * background. `0` refreshes on every read; a negative value disables it.
     */
    modelsMaxAgeMs?: number;
    maxRequestImageBytes?: number;
    requestImagePixelBudget?: number;
    requestImageMaxBytes?: number;
}
/**
 * Runtime schema; Cordis validates a profile entry against this before
 * `apply`. Volatile fields are the ones the custom settings page edits live:
 * changing them re-reads the plugin Config and restarts the affected part of
 * the provider without a DSH restart.
 */
export declare const Config: z<PluginConfig>;
/**
 * Read one plain configuration snapshot from the possibly-volatile Config the
 * Loader passes to `apply`. Nested objects are already plain because each
 * top-level field we mark volatile is a whole object.
 * @param config - live plugin Config.
 * @returns a plain object accepted by {@link resolveConfig}.
 */
export declare function readConfig(config: PluginConfig): PluginConfig;
/** A normalized, validated configuration the tunnel and adapter can use directly. */
export interface ResolvedConfig {
    readonly provider: string;
    readonly displayName: string;
    readonly ssh: Readonly<{
        host: string;
        port: number;
        user?: string;
        identityFile?: string;
        passphraseEnv?: string;
        passwordEnv?: string;
        agent?: boolean | string;
        knownHostsFile?: string;
        strictHostKeyChecking: 'yes' | 'no' | 'accept-new';
    }>;
    readonly remote: Readonly<Required<Pick<RemoteConfig, 'host' | 'port' | 'basePath'>>>;
    readonly localPort: number;
    readonly apiKeyEnv?: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly compat: Readonly<Record<string, unknown>>;
    readonly models: readonly ModelConfig[];
    readonly api: ProviderApi;
    readonly defaults: Readonly<Required<Pick<DefaultsConfig, 'contextWindow' | 'maxTokens' | 'input'>> & Pick<DefaultsConfig, 'reasoningEfforts' | 'compat' | 'api'>>;
    readonly discoverModels: boolean;
    readonly knownModels: boolean;
    readonly reasoning?: ThinkingLevel;
    readonly retryPolicy?: RetryPolicyConfig;
    readonly streamIdleTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly startupTimeoutMs: number;
    readonly modelsMaxAgeMs: number;
    readonly maxRequestImageBytes: number;
    readonly requestImagePixelBudget: number;
    readonly requestImageMaxBytes: number;
}
/** Expand a leading `~` and normalize separators. */
export declare function expandHome(value: string): string;
/** Normalize an API root to either empty or `/segment[/segment...]` without a trailing slash. */
export declare function normalizeBasePath(value: string | undefined): string;
/**
 * Validate and normalize one plugin configuration.
 * @param config - schema-validated configuration from Cordis.
 * @returns the normalized configuration, including every adapter-owned default.
 * @throws Error naming the configuration field that cannot be served.
 */
export declare function resolveConfig(config: PluginConfig): ResolvedConfig;
