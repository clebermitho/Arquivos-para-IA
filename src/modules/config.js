/**
 * config.js — Configurações globais e constantes da extensão AssistentePlay
 *
 * Centraliza todas as constantes de configuração, chaves de storage e
 * definição do ambiente de armazenamento, eliminando duplicatas entre módulos.
 */
'use strict';

/** URL padrão do backend de produção */
export const DEFAULT_BACKEND_URL = 'https://backend-assistant-0x1d.onrender.com';

/**
 * CONFIG — configurações em tempo de execução.
 * Mutável: preenchido por carregarAppState() e atualizado por setAuthToken() / setBackendUrl().
 */
export const CONFIG = {
    OPENAI_KEY: "",          // legado — em modo extensão a chave fica no servidor
    BACKEND_URL: DEFAULT_BACKEND_URL,
    BACKEND_TOKEN: "",       // preenchido por carregarAppState() ou após login
    MAX_HISTORY_SIZE: 1000,
    SIMILARITY_THRESHOLD: 0.65,
    MAX_MESSAGES_TO_CAPTURE: 12,
    KNOWLEDGE_BASE_COREN: "https://raw.githubusercontent.com/clebermitho/knowledge-base/main/base_coren.json",
    KNOWLEDGE_BASE_CHAT:  "https://raw.githubusercontent.com/clebermitho/knowledge-base/main/programa%C3%A7%C3%A3o%20ia.json",
    // Limites por usuário (atualizados via /api/settings após login)
    LIMIT_SUGGESTIONS_PER_DAY: null,
    LIMIT_CHAT_PER_DAY: null,
    // Modelo de IA (configurável via settings da org)
    MODEL_IA: 'gpt-4o-mini',
    THEME: {
        primary:   "#4f46e5",
        secondary: "#10b981",
        danger:    "#ef4444",
        warning:   "#f59e0b",
        dark:      "#0f172a",
        light:     "#f8fafc",
        card:      "#1e293b",
    },
};

/**
 * STORAGE_ENV — define o adaptador de storage ativo.
 * "chrome" → extensão Chrome/Edge (chrome.storage.local)
 * "gm"     → userscript (Tampermonkey / Greasemonkey) — legado
 */
export const STORAGE_ENV = "chrome";

/**
 * STORAGE_KEYS — mapa centralizado de chaves do storage.
 * Usado por todos os módulos para evitar string literals espalhadas.
 */
export const STORAGE_KEYS = {
    OPENAI_KEY:    "openai_key",
    BACKEND_TOKEN: "backend_token_v1",
    REFRESH_TOKEN: "backend_refresh_token_v1",
    BACKEND_URL:   "chatplay_backend_url",
    SESSION_EXP:   "chatplay_session_exp",
    HISTORICO:     "historico_ai_v7",
    LOG_SUGESTOES: "log_sugestoes_v7",
    TEMPLATES:     "templates_ia_v7",
    DESAPROVADAS:  "sugestoes_desaprovadas_v7",
    SCORES:        "scores_respostas_v7",
    CHAT_MSGS:     "chat_messages_v7",
    STATS:         "estatisticas_v7",
    // Legadas (mantidas para limpeza controlada)
    _LEGACY_CACHE:     "cache_respostas_v7",
    _LEGACY_HISTORICO: "historico_respostas_v7",
};
