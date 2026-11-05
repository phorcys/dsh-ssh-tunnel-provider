/**
 * Built-in capability facts for model families a sub2api deployment commonly
 * fronts.
 *
 * Why this file exists: sub2api's `GET /v1/models` publishes only
 * `{id, type, display_name, created_at}` — no context window, no output cap,
 * and no modality list. A provider that trusted only that listing would size
 * every discovered model from route defaults (262,144 context, 32,768 output,
 * text-only), which is exactly the wrong answer for a 1M-context DeepSeek
 * route: the agent compacts far too early, caps output at a fraction of what
 * the model allows, and refuses image attachments the model would accept.
 *
 * Precedence is deliberate: a configured `models` entry wins over a discovered
 * field, which wins over a rule here, which wins over the route defaults. So
 * this table is a starting point a deployment corrects per model, never a
 * silent override. `knownModels: false` turns it off entirely.
 *
 * Facts are matched on the lowercase model id, first rule wins. Only families
 * with an observed deployment are listed; an unrecognized id keeps the route
 * defaults and is reported as such so the gap is visible rather than guessed.
 *
 * @module dsh-llm-ssh-tunnel/known-models
 */
import type { ProviderModality } from './config.js';
/** Capability facts one rule contributes. */
export interface KnownModelFacts {
    /** Maximum combined request and response context. */
    contextWindow?: number;
    /** Maximum output tokens. */
    maxTokens?: number;
    /** Accepted request modalities. */
    input?: readonly ProviderModality[];
    /** Selectable reasoning levels mapped to their wire spellings. */
    reasoningEfforts?: Record<string, string | null>;
}
/**
 * Look up built-in facts for one model id.
 * @param id - model id exactly as the endpoint advertises it.
 * @returns the matching rule's facts and family name, or undefined when no rule fits.
 */
export declare function lookupKnownModel(id: string): {
    family: string;
    facts: KnownModelFacts;
} | undefined;
/**
 * Whether one advertised id can serve a chat request.
 *
 * A sub2api catalog mixes chat, image-generation, embedding, and speech models.
 * This provider streams chat completions only, so advertising the rest would
 * fill the picker with choices that fail on the first request.
 * @param id - model id as the endpoint advertises it.
 * @returns false for an obviously non-chat id.
 */
export declare function isChatModelId(id: string): boolean;
/** Whether an advertised id is known to be retired upstream. */
export declare function isRetiredModelId(id: string): boolean;
/** Canonical id for an alias, or the id itself when it is not an alias. */
export declare function canonicalModelId(id: string): string;
/** Every family this build ships facts for, for diagnostics and documentation. */
export declare function knownModelFamilies(): string[];
