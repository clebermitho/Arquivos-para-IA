/**
 * storage_adapter.js — Fase B
 * Implementação do chrome_adapter para a extensão.
 * Substitui o GM_adapter quando STORAGE_ENV = "chrome".
 */
'use strict';

export const chrome_adapter = {
    async get(key, fallback = null) {
        const result = await chrome.storage.local.get(key);
        return result[key] !== undefined ? result[key] : fallback;
    },
    async set(key, value) {
        return chrome.storage.local.set({ [key]: value });
    },
    async del(key) {
        return chrome.storage.local.remove(key);
    },
    async getMany(keys) {
        return chrome.storage.local.get(keys);
    },
    isAsync: true,
};

export const _writeQueue = (() => {
    let _pending = Promise.resolve();
    return function enqueue(fn) {
        _pending = _pending
            .then(() => fn())
            .catch((err) => console.error('[AssistentePlayExt] _writeQueue erro:', err));
        return _pending;
    };
})();

export async function storageUpdate(key, updateFn, fallback = null) {
    return _writeQueue(async () => {
        const current = await chrome_adapter.get(key, fallback);
        const updated = updateFn(current);
        await chrome_adapter.set(key, updated);
        return updated;
    });
}
