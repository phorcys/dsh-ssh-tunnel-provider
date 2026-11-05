/**
 * Browser-facing settings route for the SSH-tunnel provider.
 *
 * The card is served by the DSH web server at one exact path. GET returns the
 * current connection facts plus a per-process CSRF token; POST requires that
 * token and writes both the plugin-owned settings document and, when supplied,
 * the model API key through the harness credential service. The API key literal
 * never enters a response or the settings file.
 *
 * @module dsh-llm-ssh-tunnel/web
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver';
import { PROVIDER_APIS } from './config.js';
import { saveSettingsPatch } from './settings-store.js';
/** Exact path the card reads and writes. */
export const SETTINGS_ROUTE = '/plugins/dsh-llm-ssh-tunnel/config';
/** Default credential reference when the profile names none. */
const DEFAULT_API_KEY_REF = 'SUB2API_API_KEY';
/** Maximum accepted settings body. */
const MAX_BODY_BYTES = 64 * 1024;
/** Write one JSON response without enabling cross-origin reads. */
function json(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}
/** Whether one hostname is a loopback authority, including the `localhost` name. */
function loopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized.endsWith('.localhost') || isLoopbackHost(normalized);
}
/** Whether the request's Host and optional Origin are loopback authorities. */
function loopbackRequest(req) {
    const host = req.headers.host;
    if (host === undefined)
        return false;
    try {
        if (!loopbackHostname(new URL(`http://${host}`).hostname))
            return false;
    }
    catch {
        return false;
    }
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return loopbackHostname(new URL(origin).hostname);
    }
    catch {
        return false;
    }
}
/** Read a bounded JSON body. */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (size === 0)
        throw new Error('request body is empty');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Narrow one optional string field. */
function optionalString(value, name) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string`);
    return value;
}
/** Narrow one optional positive integer field. */
function optionalPort(value, name) {
    if (value === undefined || value === null)
        return undefined;
    const port = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error(`${name} must be a port number`);
    return port;
}
/** Convert the wire body into the small stored override. */
function toSettingsPatch(body) {
    if (typeof body !== 'object' || body === null)
        throw new Error('settings body must be an object');
    const record = body;
    const settings = record.settings;
    if (typeof settings !== 'object' || settings === null)
        throw new Error('settings must be an object');
    const section = settings;
    const ssh = typeof section.ssh === 'object' && section.ssh !== null ? section.ssh : undefined;
    const remote = typeof section.remote === 'object' && section.remote !== null ? section.remote : undefined;
    const patch = {};
    if (ssh !== undefined) {
        const host = optionalString(ssh.host, 'ssh.host');
        const user = optionalString(ssh.user, 'ssh.user');
        const identityFile = optionalString(ssh.identityFile, 'ssh.identityFile');
        const knownHostsFile = optionalString(ssh.knownHostsFile, 'ssh.knownHostsFile');
        const strict = optionalString(ssh.strictHostKeyChecking, 'ssh.strictHostKeyChecking');
        if (strict !== undefined && !['yes', 'no', 'accept-new'].includes(strict)) {
            throw new Error('ssh.strictHostKeyChecking must be yes, no, or accept-new');
        }
        patch.ssh = {
            ...host === undefined ? {} : { host },
            ...optionalPort(ssh.port, 'ssh.port') === undefined ? {} : { port: optionalPort(ssh.port, 'ssh.port') },
            // Empty strings are meaningful here: they clear an override and fall
            // back to the profile value or the ssh2 default.
            ...user === undefined ? {} : { user: user.trim() },
            ...identityFile === undefined ? {} : { identityFile: identityFile.trim() },
            ...knownHostsFile === undefined ? {} : { knownHostsFile: knownHostsFile.trim() },
            ...strict === undefined ? {} : { strictHostKeyChecking: strict },
        };
    }
    if (remote !== undefined) {
        patch.remote = {
            ...optionalString(remote.host, 'remote.host') === undefined ? {} : { host: optionalString(remote.host, 'remote.host') },
            ...optionalPort(remote.port, 'remote.port') === undefined ? {} : { port: optionalPort(remote.port, 'remote.port') },
            ...optionalString(remote.basePath, 'remote.basePath') === undefined ? {} : { basePath: optionalString(remote.basePath, 'remote.basePath') },
        };
    }
    const apiKeyEnv = optionalString(section.apiKeyEnv, 'apiKeyEnv');
    if (apiKeyEnv !== undefined)
        patch.apiKeyEnv = apiKeyEnv.trim();
    const api = optionalString(section.api, 'api');
    if (api !== undefined && api.trim() !== '') {
        if (!PROVIDER_APIS.includes(api.trim())) {
            throw new Error(`api must be one of ${PROVIDER_APIS.join(', ')}`);
        }
        patch.api = api.trim();
    }
    const apiKey = optionalString(record.apiKey, 'apiKey');
    return { patch, ...apiKey === undefined || apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() } };
}
/** Describe one credential reference without exposing its value. */
async function credentialStatus(ctx, ref) {
    const credentials = ctx.get('credentials');
    if (credentials === undefined)
        return { ref, configured: false, writable: false };
    try {
        const info = await credentials.describe(credentialRef(ref));
        return { ref, configured: info.configured, writable: info.writable };
    }
    catch {
        return { ref, configured: false, writable: false };
    }
}
/** The whole settings response for the current state. */
async function settingsView(ctx, deps) {
    const settings = deps.runtime.settingsSnapshot();
    const ref = settings.apiKeyEnv ?? DEFAULT_API_KEY_REF;
    return {
        settings,
        credential: await credentialStatus(ctx, ref),
        catalog: deps.runtime.catalogSnapshot(),
        token: deps.token,
    };
}
/** One request's work, whose failures the caller turns into one response. */
async function handleSettingsRequest(ctx, deps, req, res) {
    if (!loopbackRequest(req)) {
        json(res, 403, { error: 'request is not from a loopback origin' });
        return;
    }
    if (req.method === 'GET') {
        json(res, 200, await settingsView(ctx, deps));
        return;
    }
    if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' });
        return;
    }
    if (req.headers['x-dsh-ssh-tunnel-token'] !== deps.token) {
        json(res, 403, { error: 'missing or invalid settings token' });
        return;
    }
    const body = await readJson(req);
    // A manual refresh is the deterministic trigger a user reaches for right
    // after adding models in sub2api, without waiting for the TTL.
    if (typeof body === 'object' && body !== null && body.action === 'refresh') {
        const refreshed = await deps.runtime.refreshModels();
        json(res, 200, { ...await settingsView(ctx, deps), refreshed });
        return;
    }
    const { patch, apiKey } = toSettingsPatch(body);
    // A key entered on a route that names no reference must also persist the
    // default reference; otherwise it is stored under a name the route never
    // reads and the first request fails as unauthenticated.
    if (apiKey !== undefined && (patch.apiKeyEnv === undefined || patch.apiKeyEnv === '')) {
        patch.apiKeyEnv = deps.runtime.settingsSnapshot().apiKeyEnv ?? DEFAULT_API_KEY_REF;
        if (patch.apiKeyEnv === '')
            patch.apiKeyEnv = DEFAULT_API_KEY_REF;
    }
    const ref = patch.apiKeyEnv ?? deps.runtime.settingsSnapshot().apiKeyEnv ?? DEFAULT_API_KEY_REF;
    if (apiKey !== undefined) {
        const credentials = ctx.get('credentials');
        if (credentials === undefined) {
            json(res, 503, { error: 'the credential service is not mounted; store the API key from a profile that provides it' });
            return;
        }
        await credentials.set(credentialRef(ref), apiKey);
    }
    await deps.runtime.applySettings(patch);
    await saveSettingsPatch(patch, deps.settingsFile);
    json(res, 200, await settingsView(ctx, deps));
}
/**
 * Register the settings route while a web server is mounted.
 * @param ctx - host context.
 * @param options - runtime, settings write target, and CSRF token.
 */
export function registerSettingsRoute(ctx, options) {
    const deps = { ctx, ...options };
    ctx.inject(['webServer'], (scope) => {
        scope.effect(() => {
            let dispose;
            try {
                dispose = scope.webServer.register({
                    kind: 'exact',
                    path: SETTINGS_ROUTE,
                    handler: async (req, res) => {
                        try {
                            await handleSettingsRequest(scope, deps, req, res);
                        }
                        catch (error) {
                            // A request must always answer: an unhandled rejection would
                            // leave the card's fetch pending forever.
                            const message = error instanceof Error ? error.message : String(error);
                            if (!res.headersSent)
                                json(res, 400, { error: message });
                            else
                                res.end();
                        }
                    },
                });
            }
            catch (error) {
                // A second SSH-tunnel provider shares this exact path. The provider
                // route itself still works; only its settings card is unavailable.
                scope.logger.warn(`ssh-tunnel: settings route is already registered: ${error instanceof Error ? error.message : String(error)}`);
                return () => { };
            }
            return () => dispose?.();
        }, 'ssh-tunnel: settings route');
    });
}
