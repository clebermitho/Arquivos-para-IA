/**
 * knowledge_base.js — M4: Carregamento e cache da base de conhecimento.
 *
 * Carrega o JSON canônico de conhecimento via fetch, mantendo cache em memória
 * para evitar múltiplas requisições.
 *
 * Migração futura: cachear no service worker via Cache API para disponibilidade offline.
 */
'use strict';

import { CONFIG } from './config.js';

// Cache em memória — válido durante a sessão da página
let _cacheBaseConhecimento = null;

/**
 * Tenta carregar JSON de uma lista de URLs em ordem.
 * @param {string[]} urls
 * @returns {Promise<object|null>}
 */
async function carregarComFallback(urls) {
    for (const url of urls) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`[Chatplay Assistant] ⚠️ Falha ao carregar KB (${response.status}) em ${url}`);
                continue;
            }

            const data = await response.json();
            console.log(`[Chatplay Assistant] ✅ Base de conhecimento carregada: ${url}`);
            return data;
        } catch (error) {
            console.warn(`[Chatplay Assistant] ⚠️ Erro ao carregar KB em ${url}:`, error);
        }
    }

    return null;
}

/**
 * Carrega e cacheia a base de conhecimento unificada.
 * @returns {Promise<object|null>}
 */
export async function carregarBaseConhecimento() {
    if (_cacheBaseConhecimento) return _cacheBaseConhecimento;

    const urls = [CONFIG.KNOWLEDGE_BASE_URL, ...(CONFIG.KNOWLEDGE_BASE_FALLBACK_URLS || [])];
    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento unificada...");
        _cacheBaseConhecimento = await carregarComFallback(urls);
        if (_cacheBaseConhecimento) return _cacheBaseConhecimento;

        console.error("[Chatplay Assistant] ❌ Nenhuma URL de base de conhecimento respondeu com sucesso.");
        return null;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base de conhecimento:", error);
        return null;
    }
}

/**
 * Wrapper legado para compatibilidade durante a transição.
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoCoren() { return carregarBaseConhecimento(); }

/**
 * Wrapper legado para compatibilidade durante a transição.
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoChat() { return carregarBaseConhecimento(); }
