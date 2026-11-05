/**
 * SSH-tunnelled OpenAI-compatible provider for DeepSeek Harness.
 *
 * One plugin instance owns one route. The route is a normal `LlmAdapter`
 * registered on `ctx.llm`, so model selection, tools, images, replay, token
 * accounting, and the agent loop all behave as they do for any other provider.
 * The transport is an in-process `ssh2` local forward: every request goes to a
 * loopback port that the SSH client forwards to sub2api on the NAS, so sub2api
 * never needs a public listener and no operating-system `ssh` binary is
 * required (Windows included).
 *
 * ```yaml
 * - id: llm-sub2api-ssh
 *   name: dsh-llm-ssh-tunnel
 *   config:
 *     provider: sub2api-ssh
 *     ssh:
 *       host: nas
 *       identityFile: ~/.ssh/id_ed25519
 *     remote:
 *       port: 8080
 *     apiKeyEnv: SUB2API_API_KEY
 *     discoverModels: true
 * ```
 *
 * The plugin reuses `@deepseek-ai/dsh-llm-pi-ai`'s public `PiAiAdapter` rather
 * than reimplementing the OpenAI wire format. Volatile Config fields are edited
 * by the browser settings card; a write restarts only the forward or refreshes
 * the model catalog, never the route registration.
 *
 * @module dsh-llm-ssh-tunnel
 */
import { randomBytes } from 'node:crypto';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { readConfig, resolveConfig } from './config.js';
import { TunnelProviderRuntime } from './runtime.js';
import { registerSettingsRoute } from './web.js';
import { loadSettingsPatch, mergePluginConfig, settingsFilePath } from './settings-store.js';
export { Config, readConfig, resolveConfig } from './config.js';
export { SshPiAiAdapter } from './adapter.js';
export { resolveApiKey, resolveSecret } from './credentials.js';
export { discoverModels, parseModelList } from './discovery.js';
export { KnownHosts, fingerprint, parseKnownHosts, publicKeyType } from './known-hosts.js';
export { canonicalModelId, isChatModelId, isRetiredModelId, knownModelFamilies, lookupKnownModel } from './known-models.js';
export { ModelCatalog, buildPiProvider, protocolBaseUrl, reasoningFields } from './models.js';
export { TunnelProviderRuntime } from './runtime.js';
export { SshTunnel, findFreePort, probePort } from './tunnel.js';
export { settingsFilePath, loadSettingsPatch, saveSettingsPatch, mergePluginConfig } from './settings-store.js';
export { SETTINGS_ROUTE, registerSettingsRoute } from './web.js';
export const name = 'llm-ssh-tunnel';
export const inject = ['llm'];
/**
 * Mount the provider: construct the live runtime, register the route, start
 * the in-process SSH forward, and let the settings card edit it from then on.
 * @param ctx - Cordis context carrying `llm`, credentials, attachments, and logging.
 * @param config - validated plugin configuration with volatile references.
 */
export async function apply(ctx, config) {
    const baseConfig = resolveConfig(readConfig(config));
    const settingsFile = settingsFilePath(baseConfig.provider);
    let override;
    try {
        override = await loadSettingsPatch(settingsFile);
        if (override !== undefined) {
            // Reject a stale or hand-edited document before it can take the route
            // down; the profile configuration remains the fallback.
            resolveConfig(mergePluginConfig(readConfig(config), override));
        }
    }
    catch (error) {
        ctx.logger.warn(`ssh-tunnel: ignoring plugin settings document: ${error instanceof Error ? error.message : String(error)}`);
        override = undefined;
    }
    const runtime = new TunnelProviderRuntime(ctx, config, override);
    let disposed = false;
    try {
        await runtime.start();
        ctx.effect(() => () => {
            disposed = true;
            runtime.dispose();
        });
    }
    catch (error) {
        if (!disposed)
            runtime.dispose();
        throw error;
    }
    // A custom page exists for these fields, so the generic Settings page should
    // not also generate one. The policy belongs to this plugin fiber and is
    // optional because a minimal composition may not mount Settings.
    registerSettingsRoute(ctx, {
        runtime,
        settingsFile,
        token: randomBytes(24).toString('hex'),
    });
    ctx.inject(['settings'], (scope) => {
        try {
            scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'ssh-tunnel: settings page policy');
        }
        catch {
            // An older Settings service without the policy API still serves the
            // custom page; only the duplicate auto-page suppression is lost.
        }
    });
}
/** Re-exported for consumers that want the concrete adapter type. */
export { PiAiAdapter };
