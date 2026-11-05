/**
 * Minimal OpenSSH known_hosts verification for the in-process ssh2 client.
 *
 * ssh2 accepts every host key unless a verifier is installed. This module
 * keeps the behavior users expect from the `ssh` command: a matching pinned
 * key is accepted, a changed key is refused, an unknown host follows the
 * configured policy, and `accept-new` appends the observed key. It supports
 * plain, wildcard, negated, and `|1|`-hashed host patterns; certificate
 * authorities are deliberately not treated as pinned keys.
 *
 * @module dsh-llm-ssh-tunnel/known-hosts
 */
/** Host-key verification policy. */
export type HostKeyPolicy = 'yes' | 'no' | 'accept-new';
/** One usable known_hosts line. */
interface KnownHostEntry {
    patterns: readonly string[];
    keyType: string;
    keyBase64: string;
    revoked: boolean;
}
/** Result of checking one server key. */
export interface HostKeyCheck {
    ok: boolean;
    /** Why the key was refused, when it was. */
    reason?: string;
    /** Line to append after a successful `accept-new` connection. */
    append?: string;
}
/** Parse the key type out of an SSH public-key blob. */
export declare function publicKeyType(key: Buffer): string;
/** SHA256 fingerprint in OpenSSH's display spelling. */
export declare function fingerprint(key: Buffer): string;
/** Parse one known_hosts document. */
export declare function parseKnownHosts(text: string): KnownHostEntry[];
/** A loaded known_hosts file bound to one destination. */
export declare class KnownHosts {
    private readonly entries;
    private readonly host;
    private readonly port;
    private readonly file;
    private constructor();
    /**
     * Load a known_hosts file; a missing file is an empty store.
     * @param file - known_hosts path.
     * @param host - SSH destination.
     * @param port - SSH port.
     * @returns the checker bound to that destination.
     */
    static load(file: string, host: string, port: number): Promise<KnownHosts>;
    /** The default OpenSSH known_hosts path for this user. */
    static defaultFile(): string;
    /**
     * Check one server host key.
     * @param key - raw SSH public-key blob from the server.
     * @param policy - `yes`, `no`, or `accept-new`.
     * @returns acceptance plus the line to append for an accepted new host.
     */
    check(key: Buffer, policy: HostKeyPolicy): HostKeyCheck;
    /** Append one accepted key, creating the file and directory when needed. */
    append(line: string): Promise<void>;
}
export {};
