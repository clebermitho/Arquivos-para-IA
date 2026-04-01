/**
 * state.js — Estado global da aplicação AssistentePlay
 *
 * AppState é o único objeto de estado mutable compartilhado entre módulos.
 * É declarado vazio aqui e preenchido por carregarAppState() no Bootstrap.
 * Isso permite inicialização async (chrome.storage) sem alterar os módulos.
 *
 * Migração futura: dividir em slices por módulo (Redux-like) ou IndexedDB.
 */
'use strict';

export const AppState = {
    historico:             [],
    logSugestoes:          {},
    templates: {
        NEGOCIACAO: [], SUSPENSAO: [], CANCELAMENTO: [],
        DUVIDA: [], RECLAMACAO: [], OUTROS: [],
    },
    sugestoesDesaprovadas: { respostas: [], padroes: [], categorias: {} },
    preferencias: {
        tema: "auto", notificacoes: true, autoSugestao: true,
        evitarDesaprovadas: true, usarTemplates: true, modoEconomico: false,
    },
    estatisticas:  null,   // preenchido por carregarAppState()
    sugestaoAtual: null,
    scoresRespostas: {},
    chatMessages:  [],
    ultimaPergunta: "",
    // IDs das últimas sugestões geradas (para feedback posterior)
    _lastSuggestions:   [],
    _lastSuggestionIds: [],
};
