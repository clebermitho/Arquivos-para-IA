/**
 * knowledge_base.js — M4: Carregamento e cache das bases de conhecimento externas.
 *
 * Carrega os JSONs de conhecimento do Coren e do sistema de chat via fetch,
 * mantendo cache em memória para evitar múltiplas requisições.
 *
 * Migração futura: cachear no service worker via Cache API para disponibilidade offline.
 */
'use strict';

import { CONFIG } from './config.js';

// Cache em memória — válido durante a sessão da página
let _cacheCoren = null;
let _cacheChat  = null;

/**
 * Carrega e cacheia a base de conhecimento do COREN.
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoCoren() {
    if (_cacheCoren) return _cacheCoren;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento COREN...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_COREN);
        _cacheCoren = await response.json();
        console.log("[Chatplay Assistant] ✅ Base COREN carregada!");
        return _cacheCoren;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base COREN:", error);
        return null;
    }
}

/**
 * Carrega e cacheia a base de conhecimento do Chat.
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoChat() {
    if (_cacheChat) return _cacheChat;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento do Chat...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_CHAT);
        _cacheChat = await response.json();
        console.log("[Chatplay Assistant] ✅ Base do Chat carregada!");
        return _cacheChat;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base do Chat:", error);
        return null;
    }
}
