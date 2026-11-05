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
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm';
/**
 * Wire protocols a sub2api deployment serves.
 *
 * One deployment answers all three: `POST /v1/chat/completions`,
 * `POST /v1/responses`, and `POST /v1/messages`. They differ in what the
 * gateway does with reasoning and tools, and in measured latency, so the
 * protocol is a per-model choice rather than a build-time decision.
 */
export const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
/** Default protocol for a model that names none. */
export const DEFAULT_PROVIDER_API = 'openai-completions';
/** Reasoning levels pi-ai understands, in its display order. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Default route name when the configuration does not name one. */
export const DEFAULT_PROVIDER = 'sub2api-ssh';
/** Default remote loopback host: sub2api usually listens on the NAS itself. */
export const DEFAULT_REMOTE_HOST = '127.0.0.1';
/** Default sub2api port. */
export const DEFAULT_REMOTE_PORT = 8080;
/** Default API root under the forwarded origin. */
export const DEFAULT_BASE_PATH = '/v1';
/**
 * Compatibility switches a sub2api deployment normally needs.
 *
 * pi-ai detects compatibility from the endpoint URL, and after SSH the URL is
 * `127.0.0.1:<random>`, which tells it nothing. These are the switches the
 * known-working sub2api profile uses: OpenAI-style reasoning effort, no
 * developer role, and `max_tokens` as the output cap. Every one is overridable.
 */
export const DEFAULT_COMPAT = {
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
};
/** Default model context capacity when neither configuration nor discovery sizes it. */
export const DEFAULT_CONTEXT_WINDOW = 262_144;
/** Default per-model output capability when neither configuration nor discovery sizes it. */
export const DEFAULT_MAX_TOKENS = 32_768;
/** Default request-level wait for an SSH tunnel that is still connecting. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 20;
/** Default boot-time wait for the first model discovery when no catalog was written. */
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 8;
/**
 * Default model-listing age after which the next catalog read refreshes it.
 *
 * DSH's own DeepSeek adapter uses the same ten-minute window: a stale listing
 * is re-read in the background instead of blocking the reader, and the result
 * is published only when the catalog actually changed.
 */
export const DEFAULT_MODELS_MAX_AGE_MS = 600_000;
/** Default idle ceiling while one upstream stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default accumulated base64 image payload bound. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Default total-pixel budget for one request image. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
/** Default raw encoded-byte target for one request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
const sshSchema = z.object({
    host: z.string().required(),
    port: z.number().step(1).min(1).max(65535),
    user: z.string(),
    identityFile: z.string(),
    key: z.string(),
    passphraseEnv: z.string(),
    passwordEnv: z.string(),
    agent: z.union([z.boolean(), z.string()]),
    knownHostsFile: z.string(),
    strictHostKeyChecking: z.union(['yes', 'no', 'accept-new']).default('accept-new'),
});
const remoteSchema = z.object({
    host: z.string(),
    port: z.number().step(1).min(1).max(65535).required(),
    basePath: z.string(),
});
const reasoningEffortsSchema = z.union([
    z.const(false),
    z.dict(z.union([z.string(), z.const(null)])),
]);
const modelSchema = z.object({
    id: z.string().required(),
    api: z.union(PROVIDER_APIS),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    input: z.array(z.union(['text', 'image'])),
    reasoningEfforts: reasoningEffortsSchema,
    compat: z.dict(z.any()),
});
const defaultsSchema = z.object({
    api: z.union(PROVIDER_APIS),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    input: z.array(z.union(['text', 'image'])),
    reasoningEfforts: reasoningEffortsSchema,
    compat: z.dict(z.any()),
});
/**
 * Runtime schema; Cordis validates a profile entry against this before
 * `apply`. Volatile fields are the ones the custom settings page edits live:
 * changing them re-reads the plugin Config and restarts the affected part of
 * the provider without a DSH restart.
 */
export const Config = z.object({
    provider: z.string(),
    displayName: z.string().volatile(),
    ssh: sshSchema.required().volatile(),
    remote: remoteSchema.required().volatile(),
    localPort: z.number().step(1).min(0).max(65535).volatile(),
    apiKeyEnv: z.string().volatile(),
    headers: z.dict(z.string()).volatile(),
    compat: z.dict(z.any()).volatile(),
    models: z.array(modelSchema).default([]).volatile(),
    defaults: defaultsSchema.volatile(),
    discoverModels: z.boolean().volatile(),
    knownModels: z.boolean().volatile(),
    api: z.union(PROVIDER_APIS).volatile(),
    reasoning: z.union(THINKING_LEVELS).volatile(),
    retryPolicy: RetryPolicySchema.volatile(),
    streamIdleTimeoutMs: z.number().step(1).min(1).volatile(),
    requestTimeoutSeconds: z.number().min(1).volatile(),
    startupTimeoutSeconds: z.number().min(1).volatile(),
    modelsMaxAgeMs: z.number().step(1).min(-1).volatile(),
    maxRequestImageBytes: z.number().step(1).min(1).volatile(),
    requestImagePixelBudget: z.number().step(1).min(1).volatile(),
    requestImageMaxBytes: z.number().step(1).min(1).volatile(),
});
/** True when a Config field is a Loader volatile reference. */
function isVolatileRef(value) {
    return typeof value === 'object' && value !== null
        && typeof value.get === 'function';
}
/**
 * Read one plain configuration snapshot from the possibly-volatile Config the
 * Loader passes to `apply`. Nested objects are already plain because each
 * top-level field we mark volatile is a whole object.
 * @param config - live plugin Config.
 * @returns a plain object accepted by {@link resolveConfig}.
 */
export function readConfig(config) {
    const plain = {};
    for (const [key, value] of Object.entries(config)) {
        plain[key] = isVolatileRef(value) ? value.get() : value;
    }
    return plain;
}
/** The route-key grammar DSH session headers can carry without quoting surprises. */
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The credential-reference grammar the harness credential seam accepts. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Expand a leading `~` and normalize separators. */
export function expandHome(value) {
    const trimmed = value.trim();
    if (trimmed === '~')
        return homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
        return join(homedir(), trimmed.slice(2));
    return trimmed;
}
/** Normalize an API root to either empty or `/segment[/segment...]` without a trailing slash. */
export function normalizeBasePath(value) {
    if (value === undefined)
        return DEFAULT_BASE_PATH;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '/')
        return '';
    if (/[?#\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new Error('remote.basePath must be a path without query, fragment, or control characters');
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.replace(/\/+$/, '');
}
/** Split `user@host` into its parts, rejecting a conflicting separate `user`. */
function splitDestination(host, user) {
    const trimmed = host.trim();
    if (trimmed.length === 0)
        throw new Error('ssh.host must not be empty');
    if (/\s/.test(trimmed))
        throw new Error('ssh.host must not contain whitespace');
    if (trimmed.startsWith('-'))
        throw new Error('ssh.host must not start with "-"');
    const at = trimmed.lastIndexOf('@');
    if (at <= 0) {
        if (trimmed.includes('@'))
            throw new Error('ssh.host has an empty user before "@"');
        return { host: trimmed, ...user === undefined || user.trim() === '' ? {} : { user: user.trim() } };
    }
    const embedded = trimmed.slice(0, at).trim();
    const bareHost = trimmed.slice(at + 1).trim();
    if (bareHost.length === 0)
        throw new Error('ssh.host has an empty host after "@"');
    if (user !== undefined && user.trim() !== '' && user.trim() !== embedded) {
        throw new Error(`ssh.host names user "${embedded}" but ssh.user names "${user.trim()}"; keep one`);
    }
    return { host: bareHost, user: embedded };
}
/** Validate one configured model id and its optional metadata. */
function normalizeModel(model, index) {
    const id = model.id.trim();
    if (id.length === 0)
        throw new Error(`models[${index}].id must not be empty`);
    if (/\s/.test(id))
        throw new Error(`models[${index}].id must not contain whitespace`);
    if (model.name !== undefined && model.name.trim().length === 0) {
        throw new Error(`models[${index}].name must not be empty`);
    }
    if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1)) {
        throw new Error(`models[${index}].contextWindow must be a positive integer`);
    }
    if (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1)) {
        throw new Error(`models[${index}].maxTokens must be a positive integer`);
    }
    if (model.input !== undefined && model.input.length === 0) {
        // Schemastery materializes an absent array as `[]`; that means "no answer
        // here", not "this model accepts nothing", so the route default applies.
        model = { ...model, input: undefined };
    }
    assertReasoningEfforts(model.reasoningEfforts, `models[${index}].reasoningEfforts`);
    return {
        ...model,
        id,
        ...model.name === undefined ? {} : { name: model.name.trim() },
    };
}
/** Reject a reasoning map no request could use. */
function assertReasoningEfforts(value, path) {
    if (value === undefined || value === false)
        return;
    const entries = Object.entries(value);
    if (entries.length === 0) {
        throw new Error(`${path} is empty; declare offered levels, set false, or omit the field`);
    }
    let offersThinking = false;
    for (const [level, wire] of entries) {
        if (!THINKING_LEVELS.includes(level)) {
            throw new Error(`${path}.${level} is not one of ${THINKING_LEVELS.join(', ')}`);
        }
        if (level !== 'off')
            offersThinking = true;
        if (wire !== null && wire.trim().length === 0) {
            throw new Error(`${path}.${level} must not be an empty string`);
        }
        if (wire === null && level !== 'off') {
            throw new Error(`${path}.${level} needs a wire value; only "off" may be valueless`);
        }
    }
    if (!offersThinking) {
        throw new Error(`${path} offers no level beyond "off"; set false for a non-reasoning model`);
    }
}
/**
 * Validate and normalize one plugin configuration.
 * @param config - schema-validated configuration from Cordis.
 * @returns the normalized configuration, including every adapter-owned default.
 * @throws Error naming the configuration field that cannot be served.
 */
export function resolveConfig(config) {
    const provider = (config.provider ?? DEFAULT_PROVIDER).trim();
    if (!PROVIDER_PATTERN.test(provider)) {
        throw new Error(`provider "${provider}" must match ${PROVIDER_PATTERN}`);
    }
    const destination = splitDestination(config.ssh.host, config.ssh.user);
    const identityFileRaw = config.ssh.identityFile ?? config.ssh.key;
    const identityFile = identityFileRaw !== undefined && identityFileRaw.trim().length > 0
        ? expandHome(identityFileRaw)
        : undefined;
    if (config.ssh.identityFile !== undefined && config.ssh.key !== undefined
        && expandHome(config.ssh.identityFile) !== expandHome(config.ssh.key)) {
        throw new Error('ssh.identityFile and ssh.key name different files; keep one');
    }
    if (config.ssh.port !== undefined && (!Number.isSafeInteger(config.ssh.port) || config.ssh.port < 1 || config.ssh.port > 65535)) {
        throw new Error('ssh.port must be an integer between 1 and 65535');
    }
    const remoteHost = (config.remote.host ?? DEFAULT_REMOTE_HOST).trim();
    if (remoteHost.length === 0 || /[\s/]/.test(remoteHost) || /[\u0000-\u001f\u007f]/.test(remoteHost)) {
        throw new Error('remote.host must be a host name or address without whitespace, control characters, or "/"');
    }
    if (!Number.isSafeInteger(config.remote.port) || config.remote.port < 1 || config.remote.port > 65535) {
        throw new Error('remote.port must be an integer between 1 and 65535');
    }
    const basePath = normalizeBasePath(config.remote.basePath);
    if (/\s/.test(basePath))
        throw new Error('remote.basePath must not contain whitespace');
    const localPort = config.localPort ?? 0;
    if (!Number.isSafeInteger(localPort) || localPort < 0 || localPort > 65535) {
        throw new Error('localPort must be an integer between 0 and 65535');
    }
    const models = (config.models ?? []).map(normalizeModel);
    const ids = new Set();
    for (const model of models) {
        if (ids.has(model.id))
            throw new Error(`models contains duplicate id "${model.id}"`);
        ids.add(model.id);
    }
    const discoverModels = config.discoverModels ?? models.length === 0;
    if (models.length === 0 && !discoverModels) {
        throw new Error('models is empty and discoverModels is false; configure models or enable discovery');
    }
    const headers = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
            throw new Error(`headers["${name}"] is not a valid HTTP header name`);
        }
        if (/[\r\n]/.test(value))
            throw new Error(`headers["${name}"] must not contain a newline`);
        headers[name] = value;
    }
    for (const [name, value] of [
        ['apiKeyEnv', config.apiKeyEnv],
        ['ssh.passphraseEnv', config.ssh.passphraseEnv],
        ['ssh.passwordEnv', config.ssh.passwordEnv],
    ]) {
        if (value !== undefined && value.trim() !== '' && !CREDENTIAL_REF_PATTERN.test(value.trim())) {
            throw new Error(`${name} must be a credential reference such as SUB2API_API_KEY`);
        }
    }
    return {
        provider,
        displayName: (config.displayName ?? provider).trim() || provider,
        ssh: {
            host: destination.host,
            port: config.ssh.port ?? 22,
            ...destination.user === undefined ? {} : { user: destination.user },
            ...identityFile === undefined ? {} : { identityFile },
            ...config.ssh.passphraseEnv === undefined || config.ssh.passphraseEnv.trim() === ''
                ? {}
                : { passphraseEnv: config.ssh.passphraseEnv.trim() },
            ...config.ssh.passwordEnv === undefined || config.ssh.passwordEnv.trim() === ''
                ? {}
                : { passwordEnv: config.ssh.passwordEnv.trim() },
            ...config.ssh.agent === undefined ? {} : { agent: config.ssh.agent },
            ...config.ssh.knownHostsFile === undefined || config.ssh.knownHostsFile.trim() === ''
                ? {}
                : { knownHostsFile: expandHome(config.ssh.knownHostsFile) },
            strictHostKeyChecking: config.ssh.strictHostKeyChecking ?? 'accept-new',
        },
        remote: {
            host: remoteHost,
            port: config.remote.port,
            basePath,
        },
        localPort,
        ...config.apiKeyEnv === undefined || config.apiKeyEnv.trim() === '' ? {} : { apiKeyEnv: config.apiKeyEnv.trim() },
        headers,
        compat: { ...DEFAULT_COMPAT, ...config.compat },
        models,
        api: config.api ?? DEFAULT_PROVIDER_API,
        defaults: {
            ...config.defaults?.api === undefined ? {} : { api: config.defaults.api },
            contextWindow: config.defaults?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: config.defaults?.maxTokens ?? DEFAULT_MAX_TOKENS,
            input: config.defaults?.input !== undefined && config.defaults.input.length > 0
                ? config.defaults.input
                : ['text'],
            ...config.defaults?.reasoningEfforts === undefined ? {} : { reasoningEfforts: config.defaults.reasoningEfforts },
            ...config.defaults?.compat === undefined ? {} : { compat: config.defaults.compat },
        },
        discoverModels,
        knownModels: config.knownModels ?? true,
        ...config.reasoning === undefined ? {} : { reasoning: config.reasoning },
        ...config.retryPolicy === undefined ? {} : { retryPolicy: config.retryPolicy },
        streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        requestTimeoutMs: (config.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000,
        startupTimeoutMs: (config.startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS) * 1000,
        modelsMaxAgeMs: config.modelsMaxAgeMs ?? DEFAULT_MODELS_MAX_AGE_MS,
        maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    };
}
