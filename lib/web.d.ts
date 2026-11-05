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
import type { Context } from '@deepseek-ai/cordis';
import type { TunnelProviderRuntime } from './runtime.js';
/** Exact path the card reads and writes. */
export declare const SETTINGS_ROUTE = "/plugins/dsh-llm-ssh-tunnel/config";
/**
 * Register the settings route while a web server is mounted.
 * @param ctx - host context.
 * @param options - runtime, settings write target, and CSRF token.
 */
export declare function registerSettingsRoute(ctx: Context, options: {
    runtime: TunnelProviderRuntime;
    settingsFile: string;
    token: string;
}): void;
