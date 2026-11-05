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
import type { Context } from '@deepseek-ai/cordis';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { PluginConfig } from './config.js';
export { Config, readConfig, resolveConfig } from './config.js';
export type { DefaultsConfig, ModelConfig, PluginConfig, ProviderModality, ResolvedConfig, SshConfig, ThinkingLevel, } from './config.js';
export { SshPiAiAdapter } from './adapter.js';
export { resolveApiKey, resolveSecret } from './credentials.js';
export { discoverModels, parseModelList } from './discovery.js';
export type { DiscoveredModel } from './discovery.js';
export { KnownHosts, fingerprint, parseKnownHosts, publicKeyType } from './known-hosts.js';
export { canonicalModelId, isChatModelId, isRetiredModelId, knownModelFamilies, lookupKnownModel } from './known-models.js';
export type { KnownModelFacts } from './known-models.js';
export type { HostKeyCheck, HostKeyPolicy } from './known-hosts.js';
export { ModelCatalog, buildPiProvider, protocolBaseUrl, reasoningFields } from './models.js';
export type { FactSource, ResolvedModel } from './models.js';
export { TunnelProviderRuntime } from './runtime.js';
export { SshTunnel, findFreePort, probePort } from './tunnel.js';
export { settingsFilePath, loadSettingsPatch, saveSettingsPatch, mergePluginConfig } from './settings-store.js';
export type { SettingsPatch } from './settings-store.js';
export { SETTINGS_ROUTE, registerSettingsRoute } from './web.js';
export declare const name = "llm-ssh-tunnel";
export declare const inject: string[];
/**
 * Mount the provider: construct the live runtime, register the route, start
 * the in-process SSH forward, and let the settings card edit it from then on.
 * @param ctx - Cordis context carrying `llm`, credentials, attachments, and logging.
 * @param config - validated plugin configuration with volatile references.
 */
export declare function apply(ctx: Context, config: PluginConfig): Promise<void>;
/** Re-exported for consumers that want the concrete adapter type. */
export { PiAiAdapter };
