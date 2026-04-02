/**
 * knowledge_base.js — M4: Carregamento e cache das bases de conhecimento externas.
 *
 * Carrega os JSONs de conhecimento do Coren e do sistema de chat via fetch,
 * mantendo cache em memória com TTL para evitar múltiplas requisições e
 * garantir que os dados não fiquem obsoletos por tempo indeterminado.
 *
 * ⚠️  ATENÇÃO — ESTADO DE MIGRAÇÃO:
 * Este módulo está marcado para remoção gradual (Fase 1 → Fase 4).
 * O carregamento de JSONs completos no client deve ser substituído por
 * consultas incrementais via GET /v1/knowledge/context no backend.
 * Veja: docs/fase-1-arquitetura-alvo.md, seção 5 (Plano de Migração).
 *
 * Migração futura: remover este módulo após implementação do endpoint
 * de contexto sob demanda no backend.
 */
'use strict';

import { CONFIG } from './config.js';

/** TTL do cache em memória: 10 minutos */
const CACHE_TTL_MS = 10 * 60 * 1000;

// Cache em memória com timestamp para controle de TTL
let _cacheCoren = null;
let _cacheCorenTs = 0;
let _cacheChat  = null;
let _cacheChatTs  = 0;

/**
 * Carrega e cacheia a base de conhecimento do COREN.
 * O cache expira após CACHE_TTL_MS (10 minutos).
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoCoren() {
    const now = Date.now();
    if (_cacheCoren && (now - _cacheCorenTs) < CACHE_TTL_MS) return _cacheCoren;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento COREN...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_COREN);
        _cacheCoren = await response.json();
        _cacheCorenTs = Date.now();
        console.log("[Chatplay Assistant] ✅ Base COREN carregada!");
        return _cacheCoren;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base COREN:", error);
        return null;
    }
}

/**
 * Carrega e cacheia a base de conhecimento do Chat.
 * O cache expira após CACHE_TTL_MS (10 minutos).
 * @returns {Promise<object|null>}
 */
export async function carregarConhecimentoChat() {
    const now = Date.now();
    if (_cacheChat && (now - _cacheChatTs) < CACHE_TTL_MS) return _cacheChat;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento do Chat...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_CHAT);
        _cacheChat = await response.json();
        _cacheChatTs = Date.now();
        console.log("[Chatplay Assistant] ✅ Base do Chat carregada!");
        return _cacheChat;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base do Chat:", error);
        return null;
    }
}

/**
 * Invalida o cache em memória de ambas as bases.
 * Útil para forçar recarga após atualização da base de conhecimento.
 */
export function invalidarCacheConhecimento() {
    _cacheCoren   = null;
    _cacheCorenTs = 0;
    _cacheChat    = null;
    _cacheChatTs  = 0;
    console.log("[Chatplay Assistant] 🗑️ Cache das bases de conhecimento invalidado.");
}
