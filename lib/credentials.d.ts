/**
 * Credential resolution shared by the model key and the SSH auth material.
 *
 * The harness credential service is the primary plane; a headless profile that
 * mounts no credential service falls back to the launch environment, then the
 * process environment. A named reference that resolves to nothing fails loud
 * rather than silently using an unrelated ambient value.
 *
 * @module dsh-llm-ssh-tunnel/credentials
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Resolve one reference through credentials, then the launch environment, then
 * the process environment.
 * @param ctx - host context.
 * @param ref - credential reference.
 * @param label - human-readable purpose for the failure message.
 * @returns the literal value, or undefined when the reference is unset.
 * @throws LlmError `MISSING_CREDENTIAL` when a named reference has no value.
 */
export declare function resolveSecret(ctx: Context, ref: string | undefined, label?: string): Promise<string | undefined>;
/**
 * Resolve a model API key with the extra HTTP-header safety check.
 * @param ctx - host context.
 * @param ref - credential reference.
 * @returns the usable key, or undefined when the route names no credential.
 */
export declare function resolveApiKey(ctx: Context, ref: string | undefined): Promise<string | undefined>;
