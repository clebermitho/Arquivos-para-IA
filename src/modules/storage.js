/**
 * storage.js — M1: Adaptadores de storage, fila de escrita e persistência de estado.
 *
 * Responsabilidades:
 *   - Abstrair chrome.storage.local (extensão) e GM_* (userscript legado)
 *   - Serializar escritas concorrentes via _writeQueue (mutex FIFO)
 *   - Carregar e sincronizar AppState com chrome.storage (carregarAppState)
 *   - Detectar atualizações externas via onChanged (multi-aba / Fase C)
 *
 * Migração futura: mover carregarAppState para service worker via Cache API.
 */
'use strict';

import { CONFIG, STORAGE_KEYS, STORAGE_ENV } from './config.js';
import { AppState } from './state.js';

// ── GM_adapter ── síncrono, zero overhead (userscript legado) ─────────────
const GM_adapter = {
    get: (key, fallback = null) => {
        if (typeof GM_getValue === 'undefined') return fallback;
        const raw = GM_getValue(key, undefined);
        if (raw === undefined) return fallback;
        try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch { return raw; }
    },
    set: (key, value) => {
        if (typeof GM_setValue !== 'undefined') GM_setValue(key, JSON.stringify(value));
    },
    del: (key) => {
        if (typeof GM_deleteValue !== 'undefined') GM_deleteValue(key);
    },
    getMany: (keys) => {
        const result = {};
        keys.forEach(k => { result[k] = GM_adapter.get(k); });
        return result;
    },
    isAsync: false,
};

// ── chrome_adapter ── assíncrono, para extensão Chrome/Edge ──────────────
const chrome_adapter = {
    get: async (key, fallback = null) => {
        const r = await chrome.storage.local.get(key);
        return r[key] !== undefined ? r[key] : fallback;
    },
    set: async (key, value) => chrome.storage.local.set({ [key]: value }),
    del: async (key) => chrome.storage.local.remove(key),
    getMany: async (keys) => chrome.storage.local.get(keys),
    isAsync: true,
};

/** Adaptador ativo — controlado por STORAGE_ENV em config.js */
export const _adapter = STORAGE_ENV === "chrome" ? chrome_adapter : GM_adapter;

/**
 * _writeQueue — mutex FIFO para escritas concorrentes.
 * Encadeia operações em Promise chain para evitar Lost Update em RMW.
 * Ref: https://developer.chrome.com/docs/extensions/reference/storage/
 */
export const _writeQueue = (() => {
    let _pending = Promise.resolve();
    return function enqueue(fn) {
        _pending = _pending
            .then(() => fn())
            .catch((err) => {
                console.error("[Chatplay Assistant] ⚠️ _writeQueue erro (isolado):", err);
            });
        return _pending;
    };
})();

// ── Wrappers públicos ────────────────────────────────────────────────────

/** Lê um valor do storage com fallback. */
export function storageGet(key, fallback = null) {
    return _adapter.get(key, fallback);
}

/**
 * Salva um valor no storage — todas as escritas passam pela _writeQueue.
 * Garante serialização FIFO: sem Lost Update mesmo com múltiplas chamadas.
 */
export function storageSet(key, value) {
    return _writeQueue(() => _adapter.set(key, value));
}

/**
 * Operação read-modify-write atômica dentro da _writeQueue.
 * Uso: quando a escrita depende do valor atual (incremento, append).
 */
export function storageUpdate(key, updateFn, fallback = null) {
    return _writeQueue(async () => {
        const current = await Promise.resolve(_adapter.get(key, fallback));
        const updated = updateFn(current);
        await Promise.resolve(_adapter.set(key, updated));
        return updated;
    });
}

/** Leitura em batch — mais eficiente que N gets separados. */
export function storageGetMany(keys) {
    return _adapter.getMany(keys);
}

/** Remove uma chave do storage. */
export function storageDel(key) {
    return _writeQueue(() => _adapter.del(key));
}

// ── garantirEstruturaEstatisticas ──────────────────────────────────────
export function garantirEstruturaEstatisticas(estatisticas) {
    if (!estatisticas) {
        estatisticas = {
            totalSugestoes: 0, totalEconomiaAPI: 0, totalDesaprovadas: 0,
            totalCacheHits: 0, totalTemplateUso: 0,
            categoriasMaisUsadas: {},
            performance: { tempoMedioResposta: 0, totalTempo: 0, chamadasAPI: 0 },
        };
    }
    if (!estatisticas.performance) {
        estatisticas.performance = { tempoMedioResposta: 0, totalTempo: 0, chamadasAPI: 0 };
    }
    estatisticas.performance.chamadasAPI        = estatisticas.performance.chamadasAPI        ?? 0;
    estatisticas.performance.totalTempo         = estatisticas.performance.totalTempo         ?? 0;
    estatisticas.performance.tempoMedioResposta = estatisticas.performance.tempoMedioResposta ?? 0;
    return estatisticas;
}

/**
 * carregarAppState — lê todo o estado persistido em uma única operação batch
 * e popula AppState + CONFIG.
 */
export async function carregarAppState() {
    const keys = [
        STORAGE_KEYS.OPENAI_KEY,
        STORAGE_KEYS.BACKEND_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.BACKEND_URL,
        STORAGE_KEYS.HISTORICO,
        STORAGE_KEYS.LOG_SUGESTOES,
        STORAGE_KEYS.TEMPLATES,
        STORAGE_KEYS.DESAPROVADAS,
        STORAGE_KEYS.SCORES,
        STORAGE_KEYS.CHAT_MSGS,
        STORAGE_KEYS.STATS,
    ];

    const stored = await Promise.resolve(storageGetMany(keys));

    AppState.historico             = stored[STORAGE_KEYS.HISTORICO]    || [];
    AppState.logSugestoes          = stored[STORAGE_KEYS.LOG_SUGESTOES] || {};
    AppState.templates             = stored[STORAGE_KEYS.TEMPLATES]    || {};
    AppState.sugestoesDesaprovadas = stored[STORAGE_KEYS.DESAPROVADAS] || {
        respostas: [], categorias: {}, padroes: [],
    };
    AppState.scoresRespostas = stored[STORAGE_KEYS.SCORES]     || {};
    AppState.chatMessages    = stored[STORAGE_KEYS.CHAT_MSGS]  || [];
    AppState.estatisticas    = garantirEstruturaEstatisticas(stored[STORAGE_KEYS.STATS]);

    // Sincronizar configurações com storage
    const savedKey   = stored[STORAGE_KEYS.OPENAI_KEY];
    const savedToken = stored[STORAGE_KEYS.BACKEND_TOKEN];
    const savedBkUrl = stored[STORAGE_KEYS.BACKEND_URL];
    if (savedKey)   CONFIG.OPENAI_KEY     = savedKey;
    if (savedToken) CONFIG.BACKEND_TOKEN  = savedToken;
    if (savedBkUrl) CONFIG.BACKEND_URL    = savedBkUrl;

    console.log("[Chatplay Assistant] 📦 AppState carregado (batch).");
}

/**
 * _inicializarOnChanged — listener multi-aba (Fase C).
 * Detecta escritas de outras abas/processos e reconcilia AppState.
 * Estratégia: Last-Write-Wins para scores (Math.max por campo).
 */
export function _inicializarOnChanged() {
    if (STORAGE_ENV !== "chrome" || typeof chrome === "undefined" || !chrome.storage) return;

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;

        if (changes[STORAGE_KEYS.SCORES]) {
            const externo = changes[STORAGE_KEYS.SCORES].newValue || {};
            Object.keys(externo).forEach(resp => {
                const local = AppState.scoresRespostas[resp];
                if (!local) {
                    AppState.scoresRespostas[resp] = externo[resp];
                } else {
                    local.acertos  = Math.max(local.acertos,  externo[resp].acertos  || 0);
                    local.erros    = Math.max(local.erros,    externo[resp].erros    || 0);
                    local.ultimoUso = Math.max(local.ultimoUso || 0, externo[resp].ultimoUso || 0);
                }
            });
            console.log("[Chatplay Assistant] 🔄 onChanged: scores sincronizados (multi-aba).");
        }

        if (changes[STORAGE_KEYS.LOG_SUGESTOES]) {
            const externo = changes[STORAGE_KEYS.LOG_SUGESTOES].newValue || {};
            Object.keys(externo).forEach(cat => {
                if (!AppState.logSugestoes[cat]) {
                    AppState.logSugestoes[cat] = externo[cat];
                } else {
                    const ids = new Set(AppState.logSugestoes[cat].map(r => r.id));
                    externo[cat].forEach(r => {
                        if (!ids.has(r.id)) AppState.logSugestoes[cat].push(r);
                    });
                }
            });
            console.log("[Chatplay Assistant] 🔄 onChanged: logSugestoes sincronizado (multi-aba).");
        }

        if (changes[STORAGE_KEYS.STATS]) {
            const ext = changes[STORAGE_KEYS.STATS].newValue;
            if (ext) {
                AppState.estatisticas.totalSugestoes    = Math.max(AppState.estatisticas.totalSugestoes    || 0, ext.totalSugestoes    || 0);
                AppState.estatisticas.totalDesaprovadas = Math.max(AppState.estatisticas.totalDesaprovadas || 0, ext.totalDesaprovadas || 0);
                AppState.estatisticas.totalEconomiaAPI  = Math.max(AppState.estatisticas.totalEconomiaAPI  || 0, ext.totalEconomiaAPI  || 0);
            }
        }
    });

    console.log("[Chatplay Assistant] 🌐 onChanged listener ativo (modo extensão).");
}
