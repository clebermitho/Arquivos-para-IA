/**
 * backend_api.js — Cliente HTTP autenticado para o backend AssistentePlay.
 *
 * Todas as chamadas ao backend são roteadas através do background.js (service worker),
 * que centraliza autenticação, refresh de token e proxy HTTP.
 * Isso elimina a duplicação de lógica de refresh entre content script e background.
 *
 * Fallback para fetch direto disponível apenas em contextos sem chrome.runtime
 * (desenvolvimento / testes unitários).
 *
 * NOTA: openAIBridge é mantido como utilitário de desenvolvimento.
 * Em produção, toda IA passa pelo backend central (never client-side).
 */
'use strict';

import { CONFIG, STORAGE_KEYS } from './config.js';

// ── Roteamento via background.js ───────────────────────────────────────────
/**
 * _sendToBackground — envia uma mensagem ao service worker e retorna Promise.
 * @param {object} message
 * @returns {Promise<any>}
 */
function _sendToBackground(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!response?.ok) {
                const err = new Error(response?.error || `Backend HTTP ${response?.status}`);
                err.status = response?.status;
                return reject(err);
            }
            resolve(response.data);
        });
    });
}

// ── BackendAPI ─────────────────────────────────────────────────────────────
export const BackendAPI = {
    /**
     * Executa uma chamada autenticada ao backend.
     *
     * Quando em contexto de extensão Chrome, delega ao background.js via BACKEND_REQUEST.
     * O background.js é responsável por injetar o token, refrescar em 401 e fazer o fetch.
     * Isso centraliza toda a lógica de autenticação em um único lugar.
     *
     * Fallback para fetch direto está disponível apenas fora do contexto de extensão.
     *
     * @param {string} path - Caminho relativo da API (ex: '/api/ai/suggestions')
     * @param {RequestInit & { body?: string }} options
     */
    async request(path, options = {}) {
        // Contexto de extensão: delegar ao background.js
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
            const body = options.body
                ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body)
                : null;
            return _sendToBackground({
                type: 'BACKEND_REQUEST',
                payload: { path, method: options.method || 'GET', body },
            });
        }

        // Fallback: fetch direto (fora do contexto de extensão — dev/testes)
        const url = `${CONFIG.BACKEND_URL}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            ...(CONFIG.BACKEND_TOKEN ? { 'Authorization': `Bearer ${CONFIG.BACKEND_TOKEN}` } : {}),
            ...(options.headers || {}),
        };
        const res = await fetch(url, {
            method: options.method || 'GET',
            headers,
            ...(options.body ? { body: options.body } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `Backend HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    },

    /** Login — retorna token e salva em CONFIG + storage para uso imediato. */
    async login(credential, password) {
        const loginBody = credential.includes('@')
            ? { email: credential, password }
            : { username: credential, password };
        const data = await this.request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify(loginBody),
        });
        // Armazenar token em CONFIG (acesso síncrono) e em storage (persistência)
        if (data.token) {
            CONFIG.BACKEND_TOKEN = data.token;
            const toSave = { [STORAGE_KEYS.BACKEND_TOKEN]: data.token };
            if (data.refreshToken) toSave[STORAGE_KEYS.REFRESH_TOKEN] = data.refreshToken;
            if (data.expiresAt)    toSave[STORAGE_KEYS.SESSION_EXP]   = data.expiresAt;
            await chrome.storage.local.set(toSave);
        }
        return data;
    },

    /** Gera sugestões via backend (OpenAI permanece no servidor). */
    async generateSuggestions({ context, question, category, topExamples = [], avoidPatterns = [] }) {
        return this.request('/api/ai/suggestions', {
            method: 'POST',
            body: JSON.stringify({ context, question, category, topExamples, avoidPatterns }),
        });
    },

    /** Chat IA via backend. */
    async chatReply({ message, history = [], context = "" }) {
        return this.request('/api/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ message, history, context }),
        });
    },

    /** Registra evento de uso (fire-and-forget). */
    logEvent(eventType, payload = {}) {
        this.request('/api/events', {
            method: 'POST',
            body: JSON.stringify({ eventType, payload }),
        }).catch(err => console.warn('[ChatplayExt] Evento não registrado:', err.message));
    },

    /** Envia feedback de uma sugestão. */
    async sendFeedback(suggestionId, type, reason = null) {
        const body = { suggestionId, type };
        if (reason !== null && reason !== undefined) body.reason = reason;
        return this.request('/api/feedback', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    /** Busca configurações da org. */
    async getSettings() {
        return this.request('/api/settings');
    },

    /** Verifica se o backend está acessível. */
    async ping() {
        try {
            await fetch(`${CONFIG.BACKEND_URL}/health`);
            return true;
        } catch { return false; }
    },
};

// ── openAIBridge ───────────────────────────────────────────────────────────
/**
 * openAIBridge — utilitário de desenvolvimento para chamadas diretas à OpenAI.
 *
 * ⚠️  USO EXCLUSIVO DE DESENVOLVIMENTO / FALLBACK.
 * Em produção, toda IA passa pelo backend central via BackendAPI.
 * Esta função NÃO é chamada nos fluxos de produção.
 *
 * @param {{ apiKey: string, messages: object[], model?: string, max_tokens?: number, temperature?: number }}
 */
export async function openAIBridge({ apiKey, messages, model = 'gpt-4o-mini', max_tokens = 500, temperature = 0.7 }) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        // Delegar ao background.js (sem CORS em extensão MV3)
        return _sendToBackground({
            type: 'OPENAI_REQUEST',
            payload: { apiKey, messages, model, max_tokens, temperature },
        });
    }

    // Fallback: fetch direto (userscript / ambiente sem chrome.runtime)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
    });
    if (!response.ok) {
        const err = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${err.substring(0, 100)}`);
    }
    return response.json();
}
