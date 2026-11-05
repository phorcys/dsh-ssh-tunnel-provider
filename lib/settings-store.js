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
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
/** Where one route's plugin-owned settings document lives. */
export function settingsFilePath(provider) {
    const suffix = provider === undefined ? '' : `.${provider.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    return join(resolveDshHome(), `.ssh-tunnel-provider${suffix}.json`);
}
/** Merge an override over the profile configuration without mutating either. */
export function mergePluginConfig(base, patch) {
    if (patch === undefined)
        return base;
    return {
        ...base,
        ...patch.apiKeyEnv === undefined ? {} : { apiKeyEnv: patch.apiKeyEnv },
        ...patch.api === undefined ? {} : { api: patch.api },
        ssh: { ...base.ssh, ...patch.ssh },
        remote: { ...base.remote, ...patch.remote },
    };
}
/** Load the settings document; a missing or unreadable file is no override. */
export async function loadSettingsPatch(file = settingsFilePath()) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new Error(`could not read ${file}: ${error.message}`);
    }
    try {
        const document = JSON.parse(text);
        if (document.version !== 1 || typeof document.settings !== 'object' || document.settings === null) {
            throw new Error('unsupported settings document');
        }
        return document.settings;
    }
    catch (error) {
        throw new Error(`could not parse ${file}: ${error.message}`);
    }
}
/** Persist the override atomically with owner-only permissions. */
export async function saveSettingsPatch(settings, file = settingsFilePath()) {
    const document = { version: 1, settings };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // A unique temp name plus O_EXCL prevents a planted symlink or a concurrent
    // writer from redirecting the write; rename keeps the visible document atomic.
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, file);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
