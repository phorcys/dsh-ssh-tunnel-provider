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

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Characters an HTTP header can carry; the same rule the newer harness uses. */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** The credential seam's minimal shape, kept local so the plugin loads without it. */
interface CredentialResolver {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

/**
 * Resolve one reference through credentials, then the launch environment, then
 * the process environment.
 * @param ctx - host context.
 * @param ref - credential reference.
 * @param label - human-readable purpose for the failure message.
 * @returns the literal value, or undefined when the reference is unset.
 * @throws LlmError `MISSING_CREDENTIAL` when a named reference has no value.
 */
export async function resolveSecret(
  ctx: Context,
  ref: string | undefined,
  label = 'credential',
): Promise<string | undefined> {
  if (ref === undefined || ref.length === 0) return undefined
  const credentials = ctx.get('credentials') as CredentialResolver | undefined
  let value: string | undefined
  if (credentials !== undefined) {
    try {
      value = (await credentials.resolve(ref))?.value
    } catch {
      // Fall through to the launch environment; the diagnostic below still
      // names the reference that missed.
    }
  }
  if (value === undefined || value.length === 0) {
    try {
      value = launchEnvironmentOf(ctx).get(ref)?.value
    } catch {
      // No launch-environment service in this composition.
    }
  }
  if (value === undefined || value.length === 0) value = process.env[ref]
  if (value === undefined || value.length === 0) {
    throw new LlmError(
      `ssh-tunnel: ${label} "${ref}" is not set — store it through the credentials service or export it`,
      'MISSING_CREDENTIAL',
    )
  }
  return value
}

/**
 * Resolve a model API key with the extra HTTP-header safety check.
 * @param ctx - host context.
 * @param ref - credential reference.
 * @returns the usable key, or undefined when the route names no credential.
 */
export async function resolveApiKey(ctx: Context, ref: string | undefined): Promise<string | undefined> {
  const value = await resolveSecret(ctx, ref, 'model API key')
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new LlmError(
      `ssh-tunnel: the model API key resolved from "${ref ?? ''}" is blank; set the reference to the raw key`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  if (!LEGAL_API_KEY.test(trimmed)) {
    throw new LlmError(
      `ssh-tunnel: the model API key resolved from "${ref ?? ''}" contains characters no HTTP header can carry; set the reference to the raw key alone`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  return trimmed
}
