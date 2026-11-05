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
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
/** Parse the key type out of an SSH public-key blob. */
export function publicKeyType(key) {
    if (key.length < 5)
        return 'unknown';
    const length = key.readUInt32BE(0);
    if (length < 1 || length > key.length - 4)
        return 'unknown';
    return key.subarray(4, 4 + length).toString('ascii');
}
/** SHA256 fingerprint in OpenSSH's display spelling. */
export function fingerprint(key) {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
/** Parse one known_hosts document. */
export function parseKnownHosts(text) {
    const entries = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#'))
            continue;
        const fields = line.split(/\s+/);
        let index = 0;
        let revoked = false;
        if (fields[index]?.startsWith('@')) {
            const marker = fields[index];
            index += 1;
            if (marker === '@revoked')
                revoked = true;
            // @cert-authority lines pin a CA, not a server key; skip them rather
            // than treating the CA key as a host key.
            else
                continue;
        }
        const hostField = fields[index];
        const keyType = fields[index + 1];
        const keyBase64 = fields[index + 2];
        if (hostField === undefined || keyType === undefined || keyBase64 === undefined)
            continue;
        entries.push({
            patterns: hostField.split(',').filter(pattern => pattern.length > 0),
            keyType,
            keyBase64,
            revoked,
        });
    }
    return entries;
}
/** Expand the one glob syntax known_hosts uses. */
function globMatch(pattern, value) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withStars = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${withStars}$`).test(value);
}
/** Match one host pattern, including OpenSSH's `|1|salt|hash` form. */
function patternMatches(pattern, host, port) {
    const target = port === 22 ? host : `[${host}]:${port}`;
    if (pattern.startsWith('|1|')) {
        const parts = pattern.split('|');
        const salt = parts[2];
        const hash = parts[3];
        if (salt === undefined || hash === undefined)
            return false;
        const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(target).digest();
        const expected = Buffer.from(hash, 'base64');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    return globMatch(pattern, target);
}
/** A loaded known_hosts file bound to one destination. */
export class KnownHosts {
    entries;
    host;
    port;
    file;
    constructor(entries, host, port, file) {
        this.entries = entries;
        this.host = host;
        this.port = port;
        this.file = file;
    }
    /**
     * Load a known_hosts file; a missing file is an empty store.
     * @param file - known_hosts path.
     * @param host - SSH destination.
     * @param port - SSH port.
     * @returns the checker bound to that destination.
     */
    static async load(file, host, port) {
        let text = '';
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`could not read known_hosts file ${file}: ${error.message}`);
            }
        }
        return new KnownHosts(parseKnownHosts(text), host, port, file);
    }
    /** The default OpenSSH known_hosts path for this user. */
    static defaultFile() {
        return join(homedir(), '.ssh', 'known_hosts');
    }
    /**
     * Check one server host key.
     * @param key - raw SSH public-key blob from the server.
     * @param policy - `yes`, `no`, or `accept-new`.
     * @returns acceptance plus the line to append for an accepted new host.
     */
    check(key, policy) {
        const keyType = publicKeyType(key);
        const keyBase64 = key.toString('base64');
        const matchingHosts = this.entries.filter(entry => entry.patterns.some(pattern => !pattern.startsWith('!') && patternMatches(pattern, this.host, this.port))
            && !entry.patterns.some(pattern => pattern.startsWith('!') && patternMatches(pattern.slice(1), this.host, this.port)));
        const revoked = matchingHosts.find(entry => entry.revoked && entry.keyBase64 === keyBase64);
        if (revoked !== undefined) {
            return { ok: false, reason: `host key ${fingerprint(key)} is marked @revoked in ${this.file}` };
        }
        const pinned = matchingHosts.find(entry => !entry.revoked && entry.keyType === keyType && entry.keyBase64 === keyBase64);
        if (pinned !== undefined)
            return { ok: true };
        if (matchingHosts.length > 0) {
            return {
                ok: false,
                reason: `host key for ${this.host}:${this.port} does not match ${this.file} (${fingerprint(key)})`,
            };
        }
        if (policy === 'yes') {
            return {
                ok: false,
                reason: `unknown host ${this.host}:${this.port} and StrictHostKeyChecking=yes (${fingerprint(key)})`,
            };
        }
        const target = this.port === 22 ? this.host : `[${this.host}]:${this.port}`;
        return {
            ok: true,
            append: `${target} ${keyType} ${keyBase64}`,
        };
    }
    /** Append one accepted key, creating the file and directory when needed. */
    async append(line) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        let prefix = '';
        try {
            const existing = await readFile(this.file, 'utf8');
            if (existing.length > 0 && !existing.endsWith('\n'))
                prefix = '\n';
        }
        catch {
            // A missing file needs no separator.
        }
        await appendFile(this.file, `${prefix}${line}\n`, { mode: 0o600 });
    }
}
