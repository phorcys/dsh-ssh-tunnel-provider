/**
 * Small plugin-owned settings document, stored beside the DSH home.
 *
 * Third-party plugins are usually inserted into a profile patch, and the
 * built-in Config editor only rewrites entries that already exist as ordinary
 * profile rows. A plugin-owned JSON document keeps the browser card usable for
 * an inserted provider and keeps the API key out of it: the literal key lives
 * in the harness credential service, while this file holds only the reference
 * name and connection facts.
 *
 * @module dsh-llm-ssh-tunnel/settings-store
 */
import type { PluginConfig, ProviderApi, SshConfig } from './config.js';
/** One editable connection fact set. */
export interface SettingsPatch {
    ssh?: Partial<Pick<SshConfig, 'host' | 'port' | 'user' | 'identityFile' | 'knownHostsFile' | 'strictHostKeyChecking'>>;
    remote?: {
        host?: string;
        port?: number;
        basePath?: string;
    };
    apiKeyEnv?: string;
    /** Route-level wire protocol. */
    api?: ProviderApi;
}
/** Where one route's plugin-owned settings document lives. */
export declare function settingsFilePath(provider?: string): string;
/** Merge an override over the profile configuration without mutating either. */
export declare function mergePluginConfig(base: PluginConfig, patch: SettingsPatch | undefined): PluginConfig;
/** Load the settings document; a missing or unreadable file is no override. */
export declare function loadSettingsPatch(file?: string): Promise<SettingsPatch | undefined>;
/** Persist the override atomically with owner-only permissions. */
export declare function saveSettingsPatch(settings: SettingsPatch, file?: string): Promise<void>;
