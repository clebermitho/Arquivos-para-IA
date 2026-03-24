/**
 * chatplay_core.js — Módulo principal da extensão Chatplay Assistant
 * @version 9.2.0
 *
 * Derivado de: Chatplay_Assistant_v9.1.0.user.js
 * Adaptações para extensão Chrome (MV3):
 *   - STORAGE_ENV = "chrome" → usa chrome_adapter (chrome.storage.local)
 *   - GM_adapter com guards typeof (não lança erro se GM_* ausente)
 *   - CONFIG.OPENAI_KEY = "" → preenchido por carregarAppState()
 *   - setTimeout de bootstrap removido → content_script.js usa MutationObserver
 *   - fetch para api.openai.com via background.js (openAIBridge)
 *   - Exporta: { inicializar }
 *
 * Para migrar chamadas OpenAI para background.js (Fase B):
 *   Substituir fetch() em gerarRespostasIA e gerarRespostaChat
 *   pelo bridge: await openAIBridge({ apiKey, messages, model })
 */
/* ══════════════════════════════════════════════════════════════
   CONFIGURAÇÕES GLOBAIS
   Migração futura: mover para chrome.storage.sync ou options page
══════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════
   BRIDGE — OpenAI via background.js (sem CORS em extensão MV3)
   Substitui fetch() direto para api.openai.com.

   Em userscript (fallback): usa fetch() diretamente se
   chrome.runtime não estiver disponível.
══════════════════════════════════════════════════════════════ */
async function openAIBridge({ apiKey, messages, model = 'gpt-4o-mini', max_tokens = 500, temperature = 0.7 }) {
    // Se estiver rodando como extensão Chrome — delega ao background.js (sem CORS)
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'OPENAI_REQUEST', payload: { apiKey, messages, model, max_tokens, temperature } },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!response || !response.ok) {
                        reject(new Error((response && response.error) || 'Erro no background.js'));
                        return;
                    }
                    resolve(response.data);
                }
            );
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


/* ══════════════════════════════════════════════════════════════
   BACKEND API CLIENT — camada de comunicação com chatplay-backend
   Todas as chamadas à OpenAI passam por aqui em modo backend.
   Fallback: openAIBridge() se BACKEND_URL não estiver configurado.
══════════════════════════════════════════════════════════════ */

const BackendAPI = {
    /**
     * Executa fetch autenticado ao backend.
     * Injeta Bearer token automaticamente.
     */
    async request(path, options = {}) {
        // Sempre relê token e URL do storage antes de cada chamada
        // Evita "logado no popup mas sem token no core" após reload de página
        const stored = await chrome.storage.local.get([
            'backend_token_v1',
            'chatplay_backend_url',
            'backend_refresh_token_v1',
        ]);
        if (stored['backend_token_v1'])  CONFIG.BACKEND_TOKEN = stored['backend_token_v1'];
        if (stored['chatplay_backend_url']) CONFIG.BACKEND_URL = stored['chatplay_backend_url'];

        const url = `${CONFIG.BACKEND_URL}${path}`;

        const doReq = async (token) => {
            const headers = {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                ...(options.headers || {}),
            };
            return fetch(url, { ...options, headers });
        };

        let response = await doReq(CONFIG.BACKEND_TOKEN);

        // Refresh automático em 401 — resolve login aparente mas token expirado
        if (response.status === 401 && stored['backend_refresh_token_v1']) {
            try {
                const rRes = await fetch(`${CONFIG.BACKEND_URL}/api/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refreshToken: stored['backend_refresh_token_v1'] }),
                });
                if (rRes.ok) {
                    const rData = await rRes.json();
                    CONFIG.BACKEND_TOKEN = rData.token;
                    await chrome.storage.local.set({ 'backend_token_v1': rData.token });
                    response = await doReq(CONFIG.BACKEND_TOKEN);
                }
            } catch (e) {
                console.warn('[ChatplayCore] Refresh automático falhou:', e.message);
            }
        }

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Backend HTTP ${response.status}`);
        }
        return response.json();
    },

    /** Login — salva token no CONFIG e no storage */
    async login(email, password) {
        const data = await this.request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        CONFIG.BACKEND_TOKEN = data.token;
        storageSet(STORAGE_KEYS.BACKEND_TOKEN, data.token);
        return data;
    },

    /** Gera sugestões via backend (OpenAI fica no servidor) */
    async generateSuggestions({ context, question, category, topExamples = [], avoidPatterns = [] }) {
        return this.request('/api/ai/suggestions', {
            method: 'POST',
            body: JSON.stringify({ context, question, category, topExamples, avoidPatterns }),
        });
    },

    /** Chat IA via backend — envia contexto, bases JSON e system prompt */
    async chatReply({ message, history = [], context = "", knowledge = null, systemPrompt = "" }) {
        return this.request('/api/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ message, history, context, knowledge, systemPrompt }),
        });
    },

    /** Registra evento de uso (fire-and-forget) */
    logEvent(eventType, payload = {}) {
        this.request('/api/events', {
            method: 'POST',
            body: JSON.stringify({ eventType, payload }),
        }).catch(err => console.warn('[ChatplayExt] Evento não registrado:', err.message));
    },

    /** Envia feedback de sugestão */
    async sendFeedback(suggestionId, type, reason = null) {
        const body = { suggestionId, type };
        if (reason !== null && reason !== undefined) body.reason = reason;
        return this.request('/api/feedback', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    /** Busca configurações da org */
    async getSettings() {
        return this.request('/api/settings');
    },

    /** Verifica se o backend está acessível */
    async ping() {
        try {
            await fetch(`${CONFIG.BACKEND_URL}/health`);
            return true;
        } catch { return false; }
    },
};

const CONFIG = {
    OPENAI_KEY: "", // legado — em modo extensão a chave fica no servidor
    BACKEND_URL: "https://backend-assistant-0x1d.onrender.com", // URL padrão do servidor de produção
    BACKEND_TOKEN: "", // preenchido por carregarAppState() ou após login
    MAX_HISTORY_SIZE: 1000,
    SIMILARITY_THRESHOLD: 0.65,
    MAX_MESSAGES_TO_CAPTURE: 12,
    KNOWLEDGE_BASE_COREN: "https://raw.githubusercontent.com/clebermitho/knowledge-base/main/base_coren.json",
    KNOWLEDGE_BASE_CHAT: "https://raw.githubusercontent.com/clebermitho/knowledge-base/main/programa%C3%A7%C3%A3o%20ia.json",
    THEME: {
        primary: "#4f46e5",
        secondary: "#10b981",
        danger: "#ef4444",
        warning: "#f59e0b",
        dark: "#0f172a",
        light: "#f8fafc",
        card: "#1e293b"
    }
};

/* ══════════════════════════════════════════════════════════════
   ESTADO DA APLICAÇÃO
   Migração futura: dividir em slices por módulo (Redux-like)
══════════════════════════════════════════════════════════════ */

/**
 * AppState — estado global da aplicação.
 * Declarado vazio aqui; preenchido por carregarAppState() no Bootstrap.
 * Isso permite inicialização async (chrome.storage) sem alterar os módulos.
 */
let AppState = {
    historico:              [],
    logSugestoes:           {},
    templates: {
        NEGOCIACAO: [], SUSPENSAO: [], CANCELAMENTO: [],
        DUVIDA: [], RECLAMACAO: [], OUTROS: []
    },
    sugestoesDesaprovadas:  { respostas: [], padroes: [], categorias: {} },
    preferencias: {
        tema: "auto", notificacoes: true, autoSugestao: true,
        evitarDesaprovadas: true, usarTemplates: true, modoEconomico: false
    },
    estatisticas:           null, // preenchido por carregarAppState()
    sugestaoAtual:          null,
    scoresRespostas:        {},
    chatMessages:           [],
};

// Variáveis de controle de UI (não persistidas)
let isGenerating        = false;
let conhecimentoBaseCoren = null;
let conhecimentoBaseChat  = null;
let sugestaoSelecionadaAtual = null; // rastreia botão selecionado visualmente

/* ══════════════════════════════════════════════════════════════
   [M1] MODULE: Storage
   Persistência, inicialização de estado, fila de escrita e limpeza.

   ┌─────────────────────────────────────────────────────────────┐
   │  StorageAdapter — troca de backend sem alterar o restante   │
   │  ENV = "gm"     → usa GM_setValue / GM_getValue (userscript)│
   │  ENV = "chrome" → usa chrome.storage.local (extensão)       │
   │  Para migrar: alterar STORAGE_ENV = "chrome" + Fase B async │
   └─────────────────────────────────────────────────────────────┘

   Fase A  (atual)  : GM_adapter ativo, _writeQueue preparada
   Fase B  (extensão): chrome_adapter ativo, storageSet/Get async
   Fase C  (multi-aba): onChanged listener ativo (já incluído)
══════════════════════════════════════════════════════════════ */

/**
 * ── STORAGE ENV ───────────────────────────────────────────────
 * "gm"     → userscript (Tampermonkey / Greasemonkey)
 * "chrome" → extensão Chrome/Edge/Firefox (Fase B)
 * Altere aqui para ativar o adaptador correto.
 */
const STORAGE_ENV = "chrome"; // ← extensão Chrome: usa chrome_adapter

/* ── GM_adapter ── síncrono, zero overhead ───────────────────── */
const GM_adapter = {
    get:    (key, fallback = null) => {
        if (typeof GM_getValue === 'undefined') return fallback;
        const raw = GM_getValue(key, undefined);
        if (raw === undefined) return fallback;
        try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch { return raw; }
    },
    set:    (key, value) => { if (typeof GM_setValue !== 'undefined') GM_setValue(key, JSON.stringify(value)); },
    del:    (key)        => { if (typeof GM_deleteValue !== 'undefined') GM_deleteValue(key); },
    getMany: (keys)      => {
        const result = {};
        keys.forEach(k => { result[k] = GM_adapter.get(k); });
        return result;
    },
    isAsync: false,
};

/* ── chrome_adapter ── assíncrono, para extensão (Fase B) ───── */
const chrome_adapter = {
    get: async (key, fallback = null) => {
        const r = await chrome.storage.local.get(key);
        return r[key] !== undefined ? r[key] : fallback;
    },
    set: async (key, value) => chrome.storage.local.set({ [key]: value }),
    del: async (key)        => chrome.storage.local.remove(key),
    getMany: async (keys)   => {
        const r = await chrome.storage.local.get(keys);
        return r;
    },
    isAsync: true,
};

/** Adaptador ativo — trocar STORAGE_ENV altera o backend inteiro */
const _adapter = STORAGE_ENV === "chrome" ? chrome_adapter : GM_adapter;

/* ── _writeQueue ── mutex FIFO para escritas concorrentes ─────
 *  Resolve o problema de Lost Update em operações read-modify-write.
 *  Cada storageSet/storageSetQueued enfileira e aguarda a anterior.
 *  Em Fase B (chrome.storage async), protege contra race conditions.
 *  Diagrama: Promise.resolve() → .then(opA) → .then(opB) → .then(opC)
 *  Ref: https://developer.chrome.com/docs/extensions/reference/storage/
 * ────────────────────────────────────────────────────────────── */
const _writeQueue = (() => {
    let _pending = Promise.resolve();
    return function enqueue(fn) {
        // Encadeia fn no final — cada .then só roda quando o anterior resolve
        _pending = _pending
            .then(() => fn())
            .catch((err) => {
                console.error("[Chatplay Assistant] ⚠️ _writeQueue erro (isolado):", err);
            });
        return _pending; // chamador pode await se precisar
    };
})();

/* ── STORAGE_KEYS ── mapa centralizado de chaves ─────────────── */
const STORAGE_KEYS = {
    OPENAI_KEY:     "openai_key",
    BACKEND_TOKEN:  "backend_token_v1",
    REFRESH_TOKEN:  "backend_refresh_token_v1",
    HISTORICO:      "historico_ai_v7",
    LOG_SUGESTOES:  "log_sugestoes_v7",
    TEMPLATES:      "templates_ia_v7",
    DESAPROVADAS:   "sugestoes_desaprovadas_v7",
    SCORES:         "scores_respostas_v7",
    CHAT_MSGS:      "chat_messages_v7",
    STATS:          "estatisticas_v7",
    // Legadas (mantidas para limpeza controlada)
    _LEGACY_CACHE:      "cache_respostas_v7",
    _LEGACY_HISTORICO:  "historico_respostas_v7",
};

/* ── Wrappers públicos ────────────────────────────────────────── */

/**
 * Lê um valor do storage com fallback.
 * GM_adapter: síncrono | chrome_adapter: retorna Promise
 */
function storageGet(key, fallback = null) {
    return _adapter.get(key, fallback);
}

/**
 * Salva um valor no storage — todas as escritas passam pela _writeQueue.
 * Garante serialização FIFO: sem Lost Update mesmo com múltiplas chamadas.
 * @param {string} key
 * @param {*} value
 * @returns {Promise}
 */
function storageSet(key, value) {
    return _writeQueue(() => _adapter.set(key, value));
}

/**
 * Operação read-modify-write atômica dentro da _writeQueue.
 * Uso: quando a escrita depende do valor atual (incremento, append).
 * @param {string} key
 * @param {function(currentValue): newValue} updateFn
 * @param {*} fallback valor inicial se a chave não existir
 * @returns {Promise}
 */
function storageUpdate(key, updateFn, fallback = null) {
    return _writeQueue(async () => {
        const current = await Promise.resolve(_adapter.get(key, fallback));
        const updated = updateFn(current);
        await Promise.resolve(_adapter.set(key, updated));
        return updated;
    });
}

/**
 * Leitura em batch — mais eficiente e reduz janelas de vulnerabilidade.
 * chrome_adapter: usa chrome.storage.local.get([keys]) — operação atômica nativa.
 * @param {string[]} keys
 * @returns {Object|Promise<Object>}
 */
function storageGetMany(keys) {
    return _adapter.getMany(keys);
}

/**
 * Remove uma chave do storage.
 */
function storageDel(key) {
    return _writeQueue(() => _adapter.del(key));
}

/* ── garantirEstruturaEstatisticas ───────────────────────────── */
function garantirEstruturaEstatisticas(estatisticas) {
    if (!estatisticas) {
        estatisticas = {
            totalSugestoes: 0, totalEconomiaAPI: 0, totalDesaprovadas: 0,
            totalCacheHits: 0, totalTemplateUso: 0,
            categoriasMaisUsadas: {},
            performance: { tempoMedioResposta: 0, totalTempo: 0, chamadasAPI: 0 }
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

/* ── carregarAppState ────────────────────────────────────────────
 *  Fase A: ainda síncrono com GM_adapter.
 *  Fase B: trocar storageGetMany por await _adapter.getMany(keys).
 *  Estrutura async já preparada para a troca sem alterar chamadores.
 * ────────────────────────────────────────────────────────────── */
async function carregarAppState() {
    // Leitura em batch — um único get em vez de N gets separados
    const keys = [
        STORAGE_KEYS.OPENAI_KEY,
        STORAGE_KEYS.BACKEND_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        'chatplay_backend_url',
        STORAGE_KEYS.HISTORICO,
        STORAGE_KEYS.LOG_SUGESTOES,
        STORAGE_KEYS.TEMPLATES,
        STORAGE_KEYS.DESAPROVADAS,
        STORAGE_KEYS.SCORES,
        STORAGE_KEYS.CHAT_MSGS,
        STORAGE_KEYS.STATS,
    ];

    // Em Fase A: getMany é síncrono; em Fase B: await retorna Promise
    const stored = await Promise.resolve(storageGetMany(keys));

    // Preenche AppState a partir do batch
    AppState.historico            = stored[STORAGE_KEYS.HISTORICO]   || [];
    AppState.logSugestoes         = stored[STORAGE_KEYS.LOG_SUGESTOES] || {};
    AppState.templates            = stored[STORAGE_KEYS.TEMPLATES]   || {};
    AppState.sugestoesDesaprovadas = stored[STORAGE_KEYS.DESAPROVADAS] || {
        respostas: [], categorias: {}, padroes: []
    };
    AppState.scoresRespostas      = stored[STORAGE_KEYS.SCORES]      || {};
    AppState.chatMessages         = stored[STORAGE_KEYS.CHAT_MSGS]   || [];
    AppState.estatisticas         = garantirEstruturaEstatisticas(stored[STORAGE_KEYS.STATS]);

    // Atualiza chave OpenAI se salva no storage (legado)
    const savedKey = stored[STORAGE_KEYS.OPENAI_KEY];
    if (savedKey) CONFIG.OPENAI_KEY = savedKey;

    // Carregar token e URL do backend configurados pelo popup
    const savedToken   = stored[STORAGE_KEYS.BACKEND_TOKEN];
    const savedBkUrl   = stored['chatplay_backend_url'];
    if (savedToken) CONFIG.BACKEND_TOKEN = savedToken;
    if (savedBkUrl) CONFIG.BACKEND_URL   = savedBkUrl;

    console.log("[Chatplay Assistant] 📦 AppState carregado (batch).");
}

/* ── onChanged — sincronização multi-aba (Fase C) ────────────────
 *  Detecta escritas de outras abas/processos e reconcilia AppState.
 *  Estratégia: Last-Write-Wins para scores (Math.max por campo).
 *  Ativa apenas no ambiente chrome (extensão).
 * ────────────────────────────────────────────────────────────── */
function _inicializarOnChanged() {
    if (STORAGE_ENV !== "chrome" || typeof chrome === "undefined" || !chrome.storage) return;

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;

        // Sincronizar scores (LWW por campo — sem regredir)
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

        // Sincronizar log de sugestões (merge por categoria)
        if (changes[STORAGE_KEYS.LOG_SUGESTOES]) {
            const externo = changes[STORAGE_KEYS.LOG_SUGESTOES].newValue || {};
            Object.keys(externo).forEach(cat => {
                if (!AppState.logSugestoes[cat]) {
                    AppState.logSugestoes[cat] = externo[cat];
                } else {
                    // Deduplica por id
                    const ids = new Set(AppState.logSugestoes[cat].map(r => r.id));
                    externo[cat].forEach(r => { if (!ids.has(r.id)) AppState.logSugestoes[cat].push(r); });
                }
            });
            console.log("[Chatplay Assistant] 🔄 onChanged: logSugestoes sincronizado (multi-aba).");
        }

        // Sincronizar estatísticas (Math.max por contador)
        if (changes[STORAGE_KEYS.STATS]) {
            const ext = changes[STORAGE_KEYS.STATS].newValue;
            if (ext) {
                AppState.estatisticas.totalSugestoes   = Math.max(AppState.estatisticas.totalSugestoes   || 0, ext.totalSugestoes   || 0);
                AppState.estatisticas.totalDesaprovadas= Math.max(AppState.estatisticas.totalDesaprovadas|| 0, ext.totalDesaprovadas|| 0);
                AppState.estatisticas.totalEconomiaAPI = Math.max(AppState.estatisticas.totalEconomiaAPI || 0, ext.totalEconomiaAPI || 0);
            }
        }
    });

    console.log("[Chatplay Assistant] 🌐 onChanged listener ativo (modo extensão).");
}

/** @namespace Storage — ponto de acesso público do módulo */
const Storage = {
    storageGet,
    storageSet,
    storageUpdate,
    storageDel,
    storageGetMany,
    carregarAppState,
    garantirEstruturaEstatisticas,
    STORAGE_KEYS,
    _writeQueue,
    _inicializarOnChanged,
    _adapter,
    STORAGE_ENV,
};

/* ══════════════════════════════════════════════════════════════
   [M2] MODULE: TextAnalysis
   Normalização, tokenização, palavras-chave, similaridade e classificação.
   Migração futura: Isolar como Web Worker ou microserviço de NLP
══════════════════════════════════════════════════════════════ */

function normalizar(txt) {
    if (!txt) return "";
    return txt
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizar(texto, pesos = false) {
    let palavras = normalizar(texto)
        .split(" ")
        .filter(p => p.length > 2);

    if (!pesos) return palavras;

    let totalDocs = AppState.historico.length || 1;
    let pesosMap = {};

    palavras.forEach(p => {
        let freqDoc = palavras.filter(w => w === p).length;
        let docsComPalavra = AppState.historico.filter(h =>
            h.tokens && h.tokens.includes(p)
        ).length;

        let idf = Math.log(totalDocs / (1 + docsComPalavra));
        pesosMap[p] = freqDoc * idf;
    });

    return pesosMap;
}

function extrairPalavrasChave(texto, limite = 5) {
    let pesos = tokenizar(texto, true);
    return Object.entries(pesos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limite)
        .map(([palavra]) => palavra);
}

function calcularSimilaridadeSemantica(a, b){
    let tokensA = tokenizar(a);
    let tokensB = tokenizar(b);
    let pesosA = tokenizar(a, true);
    let pesosB = tokenizar(b, true);

    if(tokensA.length === 0 || tokensB.length === 0) return 0;

    let stopwords = ["para", "como", "com", "uma", "pelos", "sobre", "entre", "após", "durante", "mediante", "mas", "pois", "portanto"];

    let score = 0;
    let pesoTotal = 0;

    tokensA.forEach(token => {
        let pesoToken = pesosA[token] || 1;
        if (stopwords.includes(token)) pesoToken *= 0.3;

        if(tokensB.includes(token)){
            let bonus = token.length > 6 ? 1.5 : 1;
            score += pesoToken * bonus;
        }
        pesoTotal += pesoToken;
    });

    let normalizado = pesoTotal > 0 ? score / pesoTotal : 0;

    let categoriaA = classificarIntencao(a);
    let categoriaB = classificarIntencao(b);
    if(categoriaA === categoriaB){
        normalizado += 0.2;
    }

    return Math.min(normalizado, 1);
}

function classificarIntencao(texto) {
    let t = normalizar(texto);

    const categorias = {
        SUSPENSAO: {
            palavras: ["suspens", "suspende", "paralisar", "interromper", "pausar", "baixa temporária"],
            peso: 1.5
        },
        CANCELAMENTO: {
            palavras: ["cancel", "cancela", "encerrar", "terminar", "desistir", "anular", "excluir"],
            peso: 1.5
        },
        NADA_CONSTA: {
            palavras: ["nada consta", "não consta", "sem registro", "não encontrado", "inexistente"],
            peso: 2.0
        },
        GOLPE: {
            palavras: ["golpe", "fraude", "enganaram", "problema", "suspeito", "estelionato"],
            peso: 2.0
        },
        PRAZO: {
            palavras: ["prazo", "tempo", "demora", "quanto tempo", "previsão", "quando", "data limite"],
            peso: 1.2
        },
        NEGOCIACAO: {
            palavras: ["parcel", "negoci", "acordo", "divid", "débito", "dev", "anuidade", "regularizar", "pagamento"],
            peso: 1.3
        },
        SEM_DINHEIRO: {
            palavras: ["dinheiro", "pagar", "sem condi", "caro", "valor alto", "difícil", "apertado"],
            peso: 1.3
        },
        DUVIDA: {
            palavras: ["dúvida", "dúvidas", "esclarec", "entender", "como funciona", "explicar", "significa"],
            peso: 1.0
        },
        RECLAMACAO: {
            palavras: ["reclam", "problema", "erro", "não funciona", "ruim", "péssimo", "insatisfeito"],
            peso: 1.2
        }
    };

    let scores = {};

    for (let [categoria, config] of Object.entries(categorias)) {
        let score = 0;
        for (let palavra of config.palavras) {
            if (t.includes(palavra)) {
                score += config.peso;
            }
        }
        if (score > 0) {
            scores[categoria] = score;
        }
    }

    if (t.includes("não") || t.includes("nunca") || t.includes("jamais")) {
        for (let cat in scores) {
            scores[cat] *= 0.8;
        }
    }

    if (Object.keys(scores).length > 0) {
        return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    }

    return "OUTROS";
}


/** @namespace TextAnalysis — ponto de acesso público do módulo */
const TextAnalysis = {
    normalizar,
    tokenizar,
    extrairPalavrasChave,
    calcularSimilaridadeSemantica,
    classificarIntencao,
};

/* ══════════════════════════════════════════════════════════════
   [M3] MODULE: ChatCapture
   Localização de elementos DOM, captura de mensagens e inserção de texto.
   Migração futura: Migrar para content_script da extensão
══════════════════════════════════════════════════════════════ */

function capturarMensagens(qtd = CONFIG.MAX_MESSAGES_TO_CAPTURE) {
    let msgs = [...document.querySelectorAll("span[class*='foreground']")];
    if (msgs.length === 0) return [];

    let lista = msgs.slice(-qtd).map(m => ({
        autor: descobrirAutor(m),
        texto: m.textContent ? m.textContent.trim() : m.innerText.trim(),
        timestamp: Date.now()
    }));

    console.log(`[Chatplay Assistant] 📨 Mensagens capturadas: ${lista.length}`);
    return lista;
}

function descobrirAutor(el) {
    let node = el;
    while (node) {
        if (node.className && node.className.includes("bg-secondary")) return "CLIENTE";
        if (node.className && node.className.includes("self-end")) return "OPERADOR";
        node = node.parentElement;
    }
    return "OPERADOR";
}

function detectarPergunta(mensagens) {
    let ignorar = ["ok", "sim", "obrigado", "valeu", "👍", "...", "entendi", "certo"];
    let clienteMsgs = mensagens.filter(m => m.autor === "CLIENTE");

    let validas = clienteMsgs.filter(m => {
        let t = normalizar(m.texto);
        if (t.length < 5) return false;
        if (ignorar.includes(t)) return false;
        if (/^(ok|sim|não|talvez)$/i.test(t)) return false;
        return true;
    });

    if (validas.length === 0) {
        return clienteMsgs[clienteMsgs.length - 1]?.texto || "";
    }

    return validas[validas.length - 1].texto;
}

function inserirNoCampoChatPlay(texto) {
    let campo = document.querySelector("textarea[placeholder*='Digite sua mensagem']");

    if (!campo) campo = document.querySelector("textarea");
    if (!campo) campo = document.querySelector("input[type='text']");

    if (!campo) {
        console.warn("[Chatplay Assistant] ❌ Campo de chat não encontrado");
        mostrarNotificacao("❌ Campo de chat não encontrado", "erro");
        return;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
    ).set;

    nativeSetter.call(campo, texto);

    campo.dispatchEvent(new Event('input', { bubbles: true }));
    campo.dispatchEvent(new Event('change', { bubbles: true }));

    campo.focus();

    console.log(`[Chatplay Assistant] 📝 Mensagem inserida: "${texto.substring(0, 70)}..."`);
    mostrarNotificacao("✅ Resposta inserida no chat!");
}


/** @namespace ChatCapture — ponto de acesso público do módulo */
const ChatCapture = {
    capturarMensagens,
    descobrirAutor,
    detectarPergunta,
    inserirNoCampoChatPlay,
};

/* ══════════════════════════════════════════════════════════════
   [M4] MODULE: KnowledgeBase
   Carregamento e cache das bases de conhecimento externas.
   Migração futura: Cachear no service worker da extensão via Cache API
══════════════════════════════════════════════════════════════ */

async function carregarConhecimentoCoren() {
    if (conhecimentoBaseCoren) return conhecimentoBaseCoren;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento COREN...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_COREN);
        conhecimentoBaseCoren = await response.json();
        console.log("[Chatplay Assistant] ✅ Base COREN carregada!");
        return conhecimentoBaseCoren;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base COREN:", error);
        return null;
    }
}

async function carregarConhecimentoChat() {
    if (conhecimentoBaseChat) return conhecimentoBaseChat;

    try {
        console.log("[Chatplay Assistant] 📚 Carregando base de conhecimento do Chat...");
        const response = await fetch(CONFIG.KNOWLEDGE_BASE_CHAT);
        conhecimentoBaseChat = await response.json();
        console.log("[Chatplay Assistant] ✅ Base do Chat carregada!");
        return conhecimentoBaseChat;
    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro ao carregar base do Chat:", error);
        return null;
    }
}


/** @namespace KnowledgeBase — ponto de acesso público do módulo */
const KnowledgeBase = {
    carregarConhecimentoCoren,
    carregarConhecimentoChat,
};

/* ══════════════════════════════════════════════════════════════
   [M5] MODULE: SuggestionEngine
   Templates, montagem de contexto, chamada OpenAI e fallback de respostas.
   Migração futura: Mover gerarRespostasIA para background/service worker via message passing
══════════════════════════════════════════════════════════════ */

function getTemplatesParaCategoria(categoria) {
    if (!AppState.preferencias.usarTemplates) return [];

    let templates = AppState.templates[categoria] || [];

    if (templates.length === 0) {
        templates = getTemplatesPadrao(categoria);
    }

    return templates;
}

function getTemplatesPadrao(categoria) {
    const templatesPadrao = {
        NEGOCIACAO: [
            "Verifiquei que há anuidades em aberto. Podemos negociar o pagamento de forma parcelada para regularizar sua situação.",
            "Identificamos pendências financeiras. Há opções de parcelamento disponíveis para quitação.",
            "Para regularizar sua inscrição, é necessário acertar as anuidades em aberto. Posso auxiliar com isso?"
        ],
        SUSPENSAO: [
            "A suspensão temporária da inscrição é possível mediante solicitação formal e situação regular.",
            "Para interromper temporariamente o exercício profissional, é necessário protocolar requerimento de baixa temporária.",
            "A baixa temporária pode ser solicitada quando não houver exercício profissional por período determinado."
        ],
        CANCELAMENTO: [
            "O cancelamento definitivo da inscrição requer protocolo formal e quitação de débitos existentes.",
            "Para cancelar sua inscrição, é necessário estar em dia com as obrigações e protocolar requerimento.",
            "O processo de cancelamento de inscrição deve ser formalizado junto ao protocolo geral."
        ],
        DUVIDA: [
            "Esclareço que o procedimento correto é conforme orientação do setor responsável.",
            "Para informações detalhadas, recomendo contato direto com nosso setor de atendimento.",
            "Posso auxiliar com informações gerais, mas casos específicos devem ser verificados no sistema."
        ],
        RECLAMACAO: [
            "Lamento pelo ocorrido. Vamos verificar a situação e dar o devido encaminhamento.",
            "Registrarei sua reclamação para análise do setor responsável.",
            "Sua manifestação será encaminhada para providências cabíveis."
        ]
    };

    return templatesPadrao[categoria] || [];
}

async function gerarRespostasIA(contexto, pergunta) {
    if (isGenerating) {
        mostrarNotificacao("⏳ Já gerando respostas, aguarde...", "aviso");
        return null;
    }

    let inicio = Date.now();
    isGenerating = true;

    try {
        // Backend é o caminho oficial para geração de sugestões
        // Reler token do storage se não estiver em memória (resolve timing no reload)
        if (!CONFIG.BACKEND_TOKEN) {
            try {
                const _s = await chrome.storage.local.get(['backend_token_v1', 'chatplay_backend_url']);
                if (_s['backend_token_v1'])     CONFIG.BACKEND_TOKEN = _s['backend_token_v1'];
                if (_s['chatplay_backend_url']) CONFIG.BACKEND_URL   = _s['chatplay_backend_url'];
            } catch (_) { /* sem chrome.storage */ }
        }
        if (CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN) {
            console.log("[Chatplay Assistant] 🌐 Gerando sugestões via backend...");
            const categoria = classificarIntencao(pergunta);

            const result = await BackendAPI.generateSuggestions({
                context:       contexto,
                question:      pergunta,
                category:      categoria,
                topExamples:   [],
                avoidPatterns: [],
            });

            const respostas = result.suggestions.map(s => s.text || s);
            // Guardar IDs para feedback posterior
            AppState._lastSuggestions    = respostas;
            AppState._lastSuggestionIds  = result.suggestions.map(s => s.id).filter(Boolean);

            BackendAPI.logEvent('suggestion.generated', {
                category:   categoria,
                count:      respostas.length,
                latencyMs:  result.latencyMs,
            });

            isGenerating = false;
            return respostas;
        }

        // ── DEV/FALLBACK: OpenAI direto — só usado se backend não estiver configurado ──
        // Sem backend configurado — modo não suportado em produção
        isGenerating = false;
        mostrarNotificacao('Serviço de IA indisponível. Faça login no popup da extensão.', 'erro');
        return null;
        console.warn("[Chatplay Core] ⚠️ DEV FALLBACK: Usando OpenAI direto. Configure o backend em produção.");
        console.log("[Chatplay Assistant] 🤖 Chamando API da OpenAI para sugestões (Modo COREN)...");

        const baseCoren = await carregarConhecimentoCoren();
        const baseChat = await carregarConhecimentoChat();

        let categoria = classificarIntencao(pergunta);
        let melhoresRespostas = getMelhoresRespostas(categoria, 3);

        let instrucoesEvitar = "";
        if (AppState.preferencias.evitarDesaprovadas && AppState.sugestoesDesaprovadas.padroes.length > 0) {
            let topPadroes = AppState.sugestoesDesaprovadas.padroes.slice(0, 5);
            instrucoesEvitar = `\n\n🚫 EVITE usar estas palavras/frases que já foram desaprovadas: ${topPadroes.map(p => `"${p.palavra}"`).join(", ")}`;
        }

        let exemplos = "";
        if (melhoresRespostas.length > 0) {
            exemplos = `\n\n📚 Exemplos de respostas que funcionaram bem para esta categoria:\n${melhoresRespostas.map(r => `- ${r}`).join('\n')}`;
        }

        const prompt = `
Você é um assistente especializado do Coren (Conselho Regional de Enfermagem).

INSTRUÇÕES BASEADAS NA BASE DE CONHECIMENTO:
BASE COREN:
${JSON.stringify(baseCoren, null, 2)}

BASE SISTEMA:
${JSON.stringify(baseChat, null, 2)}

REGRAS IMPORTANTES:
1. Nunca chame o profissional de "cliente".
2. Sempre utilize o termo "profissional", mas sem repetir excessivamente.
3. Não invente leis, resoluções ou procedimentos.
4. Mantenha respostas curtas, claras e objetivas.
5. Use tom profissional, acolhedor e seguro.
6. Sempre conduza para regularização quando envolver débitos.
7. Se não souber, informe que será verificado com o setor responsável.
8. Aprenda com exemplos de respostas que já funcionaram bem.
9. EVITE repetir respostas que foram desaprovadas anteriormente.

REGRAS DE LINGUAGEM (OBRIGATÓRIO):
- Nunca utilize termos informais.
- Sempre utilize terminologia oficial do COREN.
- Substitua automaticamente termos informais pelos oficiais abaixo:

REGRA CRÍTICA DE NEGOCIAÇÃO (OBRIGATÓRIO):

- Nunca confirme valores específicos de parcelas, entrada ou condições solicitadas pelo profissional.
- Não valide valores como R$ 100,00, R$ 50,00 ou qualquer quantia sugerida pelo profissional.
- Não monte propostas personalizadas com valores.

- Sempre informe que será necessário verificar no sistema quais condições estão disponíveis.

- Utilize frases como:
  "Posso verificar no sistema se há alguma condição mais acessível para você"
  "Vou consultar as possibilidades disponíveis para encontrar a melhor alternativa"
  "As condições seguem critérios do sistema, mas posso verificar uma opção mais viável para você"

- Nunca diga que pode alterar valores manualmente.
- Nunca simule negociação fora das regras do sistema.

"carteirinha" → "CIP - Carteira de Identidade Profissional"
"liberado para trabalhar" → "habilitado legalmente para o exercício profissional"
"pausar o coren" → "baixa temporária / interrupção de inscrição"
"dívida" ou "parcela" → "anuidade"
"estar devendo" → "situação irregular"
"nome sujo" → "inscrição em dívida ativa"
"enfermeiro", "auxiliar", "técnico" → "profissional"
"trabalho" ou "serviço" → "plantão"
"emprego" → "vínculo profissional"
"registro" → "inscrição profissional"
"documento" → "documento obrigatório"
"multa" → "encargos / penalidade administrativa"
"pagamento atrasado" → "inadimplência"
"estar em dia" → "situação regular"
"fiscalização" → "ação fiscalizatória"
"advertência" ou "aviso" → "notificação" ou "comunicado oficial"
"cobrança" → "processo administrativo de cobrança"
"processo" → "procedimento administrativo"
"justiça" → "esfera judicial"
"processo na justiça" → "execução fiscal"
"suspensão" → "suspensão do exercício profissional"
"cancelar registro" → "cancelamento de inscrição"
"voltar a trabalhar" → "reativação de inscrição"
"curso" → "capacitação / formação"
"certificado" → "certidão"
"prova que está em dia" → "certidão de regularidade"

IMPORTANTE:
- As respostas devem sempre soar formais, técnicas e institucionais.
- Evite gírias, linguagem simples demais ou termos populares.
${instrucoesEvitar}
${exemplos}

CONTEXTO DA CONVERSA:
${contexto}

Gere 3 respostas profissionais, objetivas e adequadas ao contexto.
NÃO use "Resposta 1:", "Resposta 2:" ou qualquer numeração. Apenas o texto da resposta.

Se a resposta não estiver clara ou não houver informação suficiente,
NUNCA deixe em branco.

Sempre gere uma resposta útil baseada no contexto mais provável.
`;

        const data = await openAIBridge({
            messages:    [
                { role: "system", content: "Gerador de respostas institucionais do Coren" },
                { role: "user",   content: prompt }
            ],
            model:       "gpt-4o-mini",
            temperature: 0.7,
            max_tokens:  500,
        });

        if (!data.choices || !data.choices[0]) {
            throw new Error("Resposta inválida da API");
        }

        let texto = data.choices[0].message.content;

        let respostas = texto
            .split(/\n\s*\n/)
            .map(r => r.trim())
            .filter(r => r.length > 20)
            .slice(0, 3)
            .map(r => r.replace(/^Resposta\s*\d+[:.-]?\s*/i, ""));

        if (!AppState.estatisticas.performance) {
            AppState.estatisticas.performance = {
                tempoMedioResposta: 0,
                totalTempo: 0,
                chamadasAPI: 0
            };
        }

        let tempoResposta = Date.now() - inicio;
        AppState.estatisticas.performance.chamadasAPI = (AppState.estatisticas.performance.chamadasAPI || 0) + 1;
        AppState.estatisticas.performance.totalTempo = (AppState.estatisticas.performance.totalTempo || 0) + tempoResposta;
        AppState.estatisticas.performance.tempoMedioResposta =
            AppState.estatisticas.performance.totalTempo / AppState.estatisticas.performance.chamadasAPI;

        storageSet(STORAGE_KEYS.STATS, AppState.estatisticas);

        return respostas;

    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro na API:", error);
        mostrarNotificacao(`❌ Erro na API: ${error.message}`, "erro");
        return null;
    } finally {
        isGenerating = false;
    }
}

async function gerarRespostaChat(mensagem, baseConhecimento) {
    // Se token não está em memória, tentar reler do storage antes de bloquear
    if (!CONFIG.BACKEND_TOKEN) {
        try {
            const stored = await chrome.storage.local.get(['backend_token_v1', 'chatplay_backend_url']);
            if (stored['backend_token_v1'])  CONFIG.BACKEND_TOKEN = stored['backend_token_v1'];
            if (stored['chatplay_backend_url']) CONFIG.BACKEND_URL = stored['chatplay_backend_url'];
        } catch (_) { /* ignorar se não tiver chrome.storage */ }
    }
    if (!CONFIG.BACKEND_TOKEN) {
        return "Faça login no popup da extensão para usar o chat IA.";
    }

    try {
        // Backend como primário para o chat IA
        if (CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN) {
            console.log("[Chatplay Assistant] 🌐 Enviando mensagem para o chat via backend...");

            // ── Histórico de conversa do chat (últimas 6 trocas) ──
            const history = AppState.chatMessages
                .slice(-6)
                .map(m => ({
                    role:    m.role    || (m.tipo === 'usuario' ? 'user' : 'assistant'),
                    content: m.content || m.texto || '',
                }))
                .filter(m => m.content.trim() !== '');

            // ── Contexto: mensagens capturadas do chat do Chatplay ──
            const mensagensCapturadas = capturarMensagens();
            const contexto = mensagensCapturadas.length > 0
                ? mensagensCapturadas.map(m => `${m.autor}: ${m.texto}`).join("\n")
                : "";

            // ── Bases de conhecimento ──
            const baseCoren = await carregarConhecimentoCoren();
            const baseChat  = await carregarConhecimentoChat();

            // ── Histórico do chat (formato texto para o prompt) ──
            const historicoChat = AppState.chatMessages
                .slice(-10)
                .map(msg => `${msg.role === "user" ? "Operador" : "Assistente"}: ${msg.content || msg.texto || ""}`)
                .join("\n");

            // ── System Prompt completo ──
            const systemPrompt = `Você é um assistente inteligente que ajuda um operador humano.

IMPORTANTE:
- Você está conversando com o OPERADOR (não com o profissional).
- Responda de forma natural, como uma IA normal (tipo ChatGPT).
- NÃO assuma automaticamente que toda mensagem envolve atendimento.

CONTEXTO DO SISTEMA (use apenas quando relevante):
BASE COREN:
${JSON.stringify(baseConhecimento || baseCoren, null, 2)}

HISTÓRICO:
${historicoChat}

MENSAGEM:
${mensagem}

REGRA PRINCIPAL:
Antes de responder, identifique o tipo da pergunta:

1. Se for dúvida geral, técnica ou conversa normal:
→ Responda normalmente, de forma clara e direta.

2. Se for sobre atendimento, cliente, cobrança, ou como responder alguém:
→ Ative o modo estratégico e responda neste formato (quando possível), se necessário poderá alterar o formato:

[MENSAGEM PRONTA]

[Frase de validação empática]
[Explicação técnica de forma simples]
[Oferta de solução, passo a passo ou próximo passo]

Livre para modificar estrutura quando necessário
(chamar de profissional mas evitar fazer isso em 100% das respostas)

🎯 Por que essa resposta funciona:
- [ponto 1]
- [ponto 2]
- [ponto 3]

IMPORTANTE:
- Use emojis adequados: 🤝, 👍, ✅, ⚠️, etc.
- Use quebras de linha para deixar visualmente agradável
- Mantenha tom humano e acolhedor
- Não invente contexto de cliente se não existir
- Não force respostas estratégicas sem necessidade
- Seja natural, direto e útil
- Se a pergunta for ambígua, peça esclarecimento antes de assumir contexto
- Se a pergunta for sobre cancelamento/suspensão/Certidão única/certificado/comprovante de quitação/Nada consta/Solicitar Nova carteirinha/Renovar carteirinha, ou algo parecido: encaminhe o passo a passo com o link correto para que o cliente consiga efetuar o procedimento, avisando que qualquer dúvida o cliente deve entrar em contato com a central.
- Formule a resposta da melhor forma para o profissional.

REGRA CRÍTICA DE NEGOCIAÇÃO (OBRIGATÓRIO):
- Nunca confirme valores específicos de parcelas, entrada ou condições solicitadas pelo profissional.
- Não valide valores como R$ 100,00, R$ 50,00 ou qualquer quantia sugerida pelo profissional.
- Não monte propostas personalizadas com valores.
- Sempre informe que será necessário verificar no sistema quais condições estão disponíveis.
- Utilize frases como:
  "Posso verificar no sistema se há alguma condição mais acessível para você"
  "Vou consultar as possibilidades disponíveis para encontrar a melhor alternativa"
  "As condições seguem critérios do sistema, mas posso verificar uma opção mais viável para você"
- Nunca diga que pode alterar valores manualmente.
- Nunca simule negociação fora das regras do sistema.`;

            const result = await BackendAPI.chatReply({
                message: mensagem,
                history,
                context: contexto,
                knowledge: {
                    coren:   baseCoren,
                    sistema: baseChat,
                },
                systemPrompt,
            });
            return result.reply;
        }

        // ── DEV/FALLBACK ──
        // Sem backend — não há fallback disponível
        return "Serviço de IA indisponível. Faça login no popup da extensão.";
        console.warn("[Chatplay Core] ⚠️ DEV FALLBACK: Usando OpenAI direto. Configure o backend em produção.");
        console.log("[Chatplay Assistant] 🤖 Enviando mensagem para o chat IA (Modo Adaptativo)...");

        let historicoChat = AppState.chatMessages.slice(-10).map(msg =>
            `${msg.role === "user" ? "Operador" : "Assistente"}: ${msg.content}`
        ).join("\n");

        const prompt = `
Você é um assistente inteligente que ajuda um operador humano.

IMPORTANTE:
- Você está conversando com o OPERADOR (não com o profissional).
- Responda de forma natural, como uma IA normal (tipo ChatGPT).
- NÃO assuma automaticamente que toda mensagem envolve atendimento.

CONTEXTO DO SISTEMA (use apenas quando relevante):
BASE COREN:
${JSON.stringify(baseConhecimento, null, 2)}

HISTÓRICO:
${historicoChat}

MENSAGEM:
${mensagem}

REGRRA PRINCIPAL:
Antes de responder, identifique o tipo da pergunta:

1. Se for dúvida geral, técnica ou conversa normal:
→ Responda normalmente, de forma clara e direta.

2. Se for sobre atendimento, cliente, cobrança, ou como responder alguém:
→ Ative o modo estratégico e responda neste formato(quando possível), se necessário poderá alterar o formato:


[MENSAGEM PRONTA]

[Frase de validação empática]

[Explicação técnica de forma simples]

[Oferta de solução, passo a passo ou próximo passo]

Livre para modificar estrutura quando necessário

(chamar de profissional mas evitar fazer isso em 100% das respostas)


🎯 Por que essa resposta funciona:
- [ponto 1]
- [ponto 2]
- [ponto 3]

IMPORTANTE:
- Use emojis adequados: 🤝, 👍, ✅, ⚠️, etc.
- Use quebras de linha para deixar visualmente agradável
- Mantenha tom humano e acolhedor
- Não invente contexto de cliente se não existir
- Não force respostas estratégicas sem necessidade
- Seja natural, direto e útil
- Se a pergunta for ambígua, peça esclarecimento antes de assumir contexto
-Se a pergunta for sobre cancelamento/suspenção/Certidão unica/ certificado/ comprovante de quitação/ Nada consta/ Solicitar Nova carteirinha/ Renovar carteirinha, ou algo parecido
Poderá encaminhar o passo a passo com o link correto para que o cliente consiga efetuar o procedimento, avisando que qualquer dúvida o cliente deve entrar em contato com a central
-Formule a resposta da melhor forma para o profissional.

REGRA CRÍTICA DE NEGOCIAÇÃO (OBRIGATÓRIO):

- Nunca confirme valores específicos de parcelas, entrada ou condições solicitadas pelo profissional.
- Não valide valores como R$ 100,00, R$ 50,00 ou qualquer quantia sugerida pelo profissional.
- Não monte propostas personalizadas com valores.

- Sempre informe que será necessário verificar no sistema quais condições estão disponíveis.

- Utilize frases como:
  "Posso verificar no sistema se há alguma condição mais acessível para você"
  "Vou consultar as possibilidades disponíveis para encontrar a melhor alternativa"
  "As condições seguem critérios do sistema, mas posso verificar uma opção mais viável para você"

- Nunca diga que pode alterar valores manualmente.
- Nunca simule negociação fora das regras do sistema.

Responda agora:
`;

        const data = await openAIBridge({
            messages:    [
                { role: "system", content: "Assistente inteligente e adaptativo que responde de forma natural, com emojis e quebras de linha quando apropriado" },
                { role: "user",   content: prompt }
            ],
            model:       "gpt-4o-mini",
            temperature: 0.8,
            max_tokens:  600,
        });
        return data.choices[0].message.content;

    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro na API do chat:", error);
        return "❌ Erro ao comunicar com a IA. Verifique sua conexão e chave API.";
    }
}

async function gerarSugestoesPainel() {
    if (isGenerating) {
        mostrarNotificacao("⏳ Já gerando respostas, aguarde...", "aviso");
        return;
    }

    mostrarDigitacao("sugestoes");

    try {
        let mensagens = capturarMensagens();

        if (mensagens.length === 0) {
            removerDigitacao();
            mostrarNotificacao("❌ Nenhuma mensagem encontrada", "erro");
            return;
        }

        let pergunta = detectarPergunta(mensagens);

        if (!pergunta) {
            removerDigitacao();
            mostrarNotificacao("❌ Não foi possível detectar a pergunta", "erro");
            return;
        }

        const contexto = mensagens.map(m => {
            return `${m.autor}:\n${m.texto}`;
        }).join("\n\n") + `\n\nCLIENTE (MENSAGEM PRINCIPAL):\n${pergunta}`;

        const categoria = classificarIntencao(pergunta);

        // Verifica histórico primeiro
        let encontrado = buscarNoHistorico(pergunta);
        let respostas;

        if (encontrado) {
            respostas = encontrado.item.respostas;
            console.log("[Chatplay Assistant] 📚 Usando respostas do histórico");
        } else {
            respostas = await gerarRespostasIA(contexto, pergunta);
        }

        removerDigitacao();

        if (respostas && respostas.length > 0) {
            // Resetar seleção visual antes de adicionar novas sugestões
            sugestaoSelecionadaAtual = null;

            adicionarMensagemAoChat("assistant", JSON.stringify(respostas), "sugestoes", {
                source: encontrado ? "history" : "fresh",
                question: pergunta,
                context: contexto,
                category: categoria,
            });
            AppState.ultimaPergunta = pergunta;

            // Salvar no histórico
            salvarNoHistorico(pergunta, respostas, mensagens.map(m => m.texto).join(" "));
        } else {
            mostrarNotificacao("❌ Falha ao gerar sugestões", "erro");
        }

    } catch (error) {
        removerDigitacao();
        console.error("[Chatplay Assistant] ❌ Erro:", error);
        mostrarNotificacao("❌ Erro ao gerar sugestões", "erro");
    }
}


/** @namespace SuggestionEngine — ponto de acesso público do módulo */
const SuggestionEngine = {
    getTemplatesParaCategoria,
    getTemplatesPadrao,
    gerarRespostasIA,
    gerarRespostaChat,
    gerarSugestoesPainel,
};

/* ══════════════════════════════════════════════════════════════
   [M6] MODULE: LearningEngine
   Feedback de respostas, scores, aprendizado de templates e métricas.
   Migração futura: Centralizar em backend para compartilhar aprendizado entre sessões
══════════════════════════════════════════════════════════════ */

function salvarSugestaoNoLog(sugestao, pergunta, categoria, suggestionId = null) {
    if (!AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria] = [];
    }

    // ── Idempotência: não salva a mesma sugestão mais de uma vez ──
    const normText = normalizar(sugestao);
    const jaSalva = AppState.logSugestoes[categoria].some(r =>
        (suggestionId && r.suggestionId === suggestionId) ||
        normalizar(r.texto) === normText
    );
    if (jaSalva) {
        console.log("[Chatplay Assistant] ⚠️ Sugestão já no log — ignorando duplicata.");
        return;
    }

    let registro = {
        texto: sugestao,
        suggestionId: suggestionId || null,
        pergunta: pergunta || AppState.ultimaPergunta || "",
        data: new Date().toISOString(),
        id: Date.now()
    };

    AppState.logSugestoes[categoria].push(registro);

    // Limita a 500 entradas por categoria
    if (AppState.logSugestoes[categoria].length > 500) {
        AppState.logSugestoes[categoria] = AppState.logSugestoes[categoria].slice(-500);
    }

    // _writeQueue garante serialização — sem Lost Update em append concorrente
    storageUpdate(STORAGE_KEYS.LOG_SUGESTOES, () => AppState.logSugestoes, {});

    // Atualiza contagem de sugestões (protegida pela fila)
    AppState.estatisticas.totalSugestoes = (AppState.estatisticas.totalSugestoes || 0) + 1;
    if (!AppState.estatisticas.categoriasMaisUsadas) AppState.estatisticas.categoriasMaisUsadas = {};
    AppState.estatisticas.categoriasMaisUsadas[categoria] = (AppState.estatisticas.categoriasMaisUsadas[categoria] || 0) + 1;
    storageUpdate(STORAGE_KEYS.STATS, () => AppState.estatisticas, {});

    console.log(`[Chatplay Assistant] 📝 Sugestão salva no log | Categoria: ${categoria}`);
}

function aprenderComRespostasBoas(resposta, categoria) {
    if (!AppState.templates[categoria]) {
        AppState.templates[categoria] = [];
    }

    let similar = AppState.templates[categoria].some(t =>
        calcularSimilaridadeSemantica(t, resposta) > 0.9
    );

    if (!similar && AppState.templates[categoria].length < 20) {
        AppState.templates[categoria].push(resposta);
        storageUpdate(STORAGE_KEYS.TEMPLATES, () => AppState.templates, {});
        console.log(`[Chatplay Assistant] 📚 Novo template aprendido para ${categoria}`);
    }
}

// Mapa de controle de rate: evita duplo clique registrar 2x no mesmo intervalo
const _feedbackLock = new Map();

function atualizarScoreResposta(resposta, categoria, foiBoa) {
    const chave = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
    const lockKey = `${chave}:${foiBoa ? 'ok' : 'rej'}`;

    // ── Debounce: ignora clique duplo dentro de 2 segundos ──
    const agora = Date.now();
    if (_feedbackLock.has(lockKey) && agora - _feedbackLock.get(lockKey) < 2000) {
        console.log("[Chatplay Assistant] ⚠️ Feedback duplicado ignorado (debounce 2s).");
        return;
    }
    _feedbackLock.set(lockKey, agora);

    if (!AppState.scoresRespostas[chave]) {
        AppState.scoresRespostas[chave] = {
            acertos: 0,
            erros: 0,
            ultimoUso: Date.now()
        };
    }

    if (foiBoa) {
        AppState.scoresRespostas[chave].acertos++;
        aprenderComRespostasBoas(resposta, categoria);
    } else {
        AppState.scoresRespostas[chave].erros++;
    }

    AppState.scoresRespostas[chave].ultimoUso = Date.now();

    let scoresArray = Object.entries(AppState.scoresRespostas);
    if (scoresArray.length > 500) {
        scoresArray.sort((a, b) => b[1].ultimoUso - a[1].ultimoUso);
        let novosScores = {};
        scoresArray.slice(0, 500).forEach(([k, v]) => novosScores[k] = v);
        AppState.scoresRespostas = novosScores;
    }

    // RMW crítico — _writeQueue previne Lost Update em escritas concorrentes
    storageUpdate(STORAGE_KEYS.SCORES, () => AppState.scoresRespostas, {});
}

function getMelhoresRespostas(categoria, limite = 5) {
    let candidatas = [];

    // CORREÇÃO 4: Busca do logSugestoes ao invés de respostasUtilizadas
    if (AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria].forEach(registro => {
            let resposta = registro.texto;
            let chave = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
            let score = AppState.scoresRespostas[chave] || { acertos: 0, erros: 0 };
            let taxaAcerto = score.acertos / (score.acertos + score.erros + 0.1);
            candidatas.push({
                resposta,
                score: taxaAcerto * (score.acertos + 1)
            });
        });
    }

    getTemplatesParaCategoria(categoria).forEach(resposta => {
        let chave = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
        let score = AppState.scoresRespostas[chave] || { acertos: 0, erros: 0 };
        let taxaAcerto = score.acertos / (score.acertos + score.erros + 0.1);
        candidatas.push({
            resposta,
            score: taxaAcerto * (score.acertos + 1)
        });
    });

    candidatas.sort((a, b) => b.score - a.score);

    let unicas = [];
    let vistas = new Set();

    for (let cand of candidatas) {
        let normalizada = normalizar(cand.resposta);
        if (!vistas.has(normalizada)) {
            vistas.add(normalizada);
            unicas.push(cand.resposta);
        }
        if (unicas.length >= limite) break;
    }

    return unicas;
}

function registrarRespostaDesaprovada(resposta, pergunta, categoria, contexto, suggestionId = null) {
    console.log("[Chatplay Assistant] ❌ Registrando resposta desaprovada...");

    // ── Idempotência: não registra duplicata da mesma resposta ──
    const normResp = normalizar(resposta);
    const jaSalva = AppState.sugestoesDesaprovadas.respostas.some(r =>
        (suggestionId && r.suggestionId === suggestionId) ||
        normalizar(r.resposta) === normResp
    );
    if (jaSalva) {
        console.log("[Chatplay Assistant] ⚠️ Desaprovada já registrada — ignorando duplicata.");
        return false;
    }

    let palavrasChave = extrairPalavrasChave(resposta);

    let registro = {
        id: Date.now(),
        suggestionId: suggestionId || null,
        resposta: resposta,
        pergunta: pergunta,
        categoria: categoria,
        palavrasChave: palavrasChave,
        contexto: contexto ? contexto.substring(0, 300) : "",
        data: new Date().toISOString()
    };

    AppState.sugestoesDesaprovadas.respostas.push(registro);

    if (!AppState.sugestoesDesaprovadas.categorias[categoria]) {
        AppState.sugestoesDesaprovadas.categorias[categoria] = 0;
    }
    AppState.sugestoesDesaprovadas.categorias[categoria]++;

    palavrasChave.forEach(palavra => {
        let padraoExistente = AppState.sugestoesDesaprovadas.padroes.find(p => p.palavra === palavra);
        if (padraoExistente) {
            padraoExistente.contagem++;
            padraoExistente.ultimaVez = Date.now();
        } else {
            AppState.sugestoesDesaprovadas.padroes.push({
                palavra: palavra,
                contagem: 1,
                primeiraVez: Date.now(),
                ultimaVez: Date.now(),
                categorias: [categoria]
            });
        }
    });

    removerRespostaDosLogs(resposta, categoria);

    atualizarScoreResposta(resposta, categoria, false);

    if (AppState.sugestoesDesaprovadas.respostas.length > 500) {
        AppState.sugestoesDesaprovadas.respostas = AppState.sugestoesDesaprovadas.respostas.slice(-500);
    }

    AppState.sugestoesDesaprovadas.padroes = AppState.sugestoesDesaprovadas.padroes
        .filter(p => p.contagem > 1)
        .sort((a, b) => b.contagem - a.contagem)
        .slice(0, 100);

    // RMW crítico — serializado pela _writeQueue
    storageUpdate(STORAGE_KEYS.DESAPROVADAS, () => AppState.sugestoesDesaprovadas, { respostas: [], categorias: {}, padroes: [] });

    AppState.estatisticas.totalDesaprovadas++;
    storageUpdate(STORAGE_KEYS.STATS, () => AppState.estatisticas, {});

    console.log(`[Chatplay Assistant] ✅ Resposta desaprovada registrada! Total: ${AppState.estatisticas.totalDesaprovadas}`);
    return true;
}

function removerRespostaDosLogs(resposta, categoria) {
    // Remove do histórico
    AppState.historico = AppState.historico.map(item => {
        if (item.respostas && Array.isArray(item.respostas)) {
            item.respostas = item.respostas.filter(r => normalizar(r) !== normalizar(resposta));
            if (item.respostas.length === 0) return null;
        }
        return item;
    }).filter(item => item !== null);

    // Remove do log de sugestões
    if (AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria] = AppState.logSugestoes[categoria].filter(
            reg => normalizar(reg.texto) !== normalizar(resposta)
        );
        if (AppState.logSugestoes[categoria].length === 0) {
            delete AppState.logSugestoes[categoria];
        }
    }

    storageUpdate(STORAGE_KEYS.HISTORICO,     () => AppState.historico,     []);
    storageUpdate(STORAGE_KEYS.LOG_SUGESTOES, () => AppState.logSugestoes, {});
}

function verificarRespostaDesaprovada(resposta) {
    if (!AppState.preferencias.evitarDesaprovadas) return false;

    let palavrasChave = extrairPalavrasChave(resposta);

    for (let desaprovada of AppState.sugestoesDesaprovadas.respostas) {
        let similaridade = calcularSimilaridadeSemantica(resposta, desaprovada.resposta);
        if (similaridade > 0.8) return true;
    }

    for (let padrao of AppState.sugestoesDesaprovadas.padroes) {
        if (palavrasChave.includes(padrao.palavra) && padrao.contagem > 3) return true;
    }

    return false;
}

function filtrarRespostasDesaprovadas(respostas) {
    if (!AppState.preferencias.evitarDesaprovadas || respostas.length === 0) return respostas;

    let respostasFiltradas = respostas.filter(r => !verificarRespostaDesaprovada(r));

    if (respostasFiltradas.length < respostas.length) {
        console.log(`[Chatplay Assistant] 🚫 ${respostas.length - respostasFiltradas.length} respostas removidas por serem desaprovadas`);
    }

    return respostasFiltradas;
}

function calcularTaxaAcertoMedia() {
    let total = 0;
    let soma = 0;

    Object.values(AppState.scoresRespostas).forEach(score => {
        if (score.acertos + score.erros > 0) {
            soma += (score.acertos / (score.acertos + score.erros)) * 100;
            total++;
        }
    });

    return total > 0 ? soma / total : 0;
}


/** @namespace LearningEngine — ponto de acesso público do módulo */
const LearningEngine = {
    salvarSugestaoNoLog,
    aprenderComRespostasBoas,
    atualizarScoreResposta,
    getMelhoresRespostas,
    registrarRespostaDesaprovada,
    removerRespostaDosLogs,
    verificarRespostaDesaprovada,
    filtrarRespostasDesaprovadas,
    calcularTaxaAcertoMedia,
};

/* ══════════════════════════════════════════════════════════════
   [M7] MODULE: HistoryManager
   Histórico de conversas tratadas e exclusão de respostas desaprovadas.
   Migração futura: Migrar para IndexedDB ou backend REST para persistência cross-session
══════════════════════════════════════════════════════════════ */

function salvarNoHistorico(pergunta, respostas, contexto) {
    let registro = {
        id: Date.now(),
        pergunta,
        tokens: tokenizar(pergunta),
        categoria: classificarIntencao(pergunta),
        contexto: contexto.substring(0, 500),
        respostas,
        data: new Date().toISOString()
    };

    AppState.historico.push(registro);
    console.log(`[Chatplay Assistant] 💾 SALVO NO HISTÓRICO - Pergunta: "${pergunta.substring(0,70)}..."`);

    if (AppState.historico.length > CONFIG.MAX_HISTORY_SIZE) {
        AppState.historico = AppState.historico.slice(-CONFIG.MAX_HISTORY_SIZE);
    }

    // _writeQueue serializa o append — sem Lost Update em conversas simultâneas
    storageUpdate(STORAGE_KEYS.HISTORICO, () => AppState.historico, []);
}

function buscarNoHistorico(pergunta) {
    console.log("[Chatplay Assistant] 🔍 Buscando no histórico...");

    let melhorItem = null;
    let melhorScore = 0;

    for (let item of AppState.historico) {
        let score = calcularSimilaridadeSemantica(pergunta, item.pergunta);
        if (score > melhorScore) {
            melhorScore = score;
            melhorItem = item;
        }
    }

    if (melhorScore >= CONFIG.SIMILARITY_THRESHOLD) {
        console.log(`[Chatplay Assistant] 📚 USOU HISTÓRICO - Similaridade: ${(melhorScore*100).toFixed(1)}%`);
        AppState.estatisticas.totalEconomiaAPI++;
        storageUpdate(STORAGE_KEYS.STATS, () => AppState.estatisticas, {});
        return { tipo: "historico", item: melhorItem };
    }

    return null;
}

function excluirItemHistorico(id) {
    AppState.historico = AppState.historico.filter(item => item.id !== id);
    storageUpdate(STORAGE_KEYS.HISTORICO, () => AppState.historico, []);

    const painel = document.getElementById("ai-painel-profissional");
    if (painel) {
        const itemRemover = document.getElementById(`historico-item-${id}`);
        if (itemRemover) itemRemover.remove();
    }

    mostrarNotificacao("✅ Item excluído com sucesso!");
}

function excluirRespostaDesaprovada(id) {
    AppState.sugestoesDesaprovadas.respostas = AppState.sugestoesDesaprovadas.respostas.filter(item => item.id !== id);

    const padroesMap = new Map();
    AppState.sugestoesDesaprovadas.respostas.forEach(item => {
        item.palavrasChave.forEach(palavra => {
            if (padroesMap.has(palavra)) {
                padroesMap.get(palavra).contagem++;
            } else {
                padroesMap.set(palavra, { palavra, contagem: 1 });
            }
        });
    });

    AppState.sugestoesDesaprovadas.padroes = Array.from(padroesMap.values())
        .filter(p => p.contagem > 1)
        .sort((a, b) => b.contagem - a.contagem)
        .slice(0, 100);

    storageUpdate(STORAGE_KEYS.DESAPROVADAS, () => AppState.sugestoesDesaprovadas, { respostas: [], categorias: {}, padroes: [] });
    mostrarNotificacao("✅ Resposta desaprovada excluída!");
}


/** @namespace HistoryManager — ponto de acesso público do módulo */
const HistoryManager = {
    salvarNoHistorico,
    buscarNoHistorico,
    excluirItemHistorico,
    excluirRespostaDesaprovada,
};

/* ══════════════════════════════════════════════════════════════
   [M8] MODULE: ChatEngine
   Gerenciamento de mensagens do chat interno do assistente.
   Migração futura: Transformar em componente React/Web Component na extensão
══════════════════════════════════════════════════════════════ */

function adicionarMensagemAoChat(role, conteudo, tipo = "texto", meta = null) {
    let mensagem = {
        role: role,
        content: conteudo,
        tipo: tipo,
        timestamp: Date.now(),
        meta: meta || undefined
    };

    AppState.chatMessages.push(mensagem);

    if (AppState.chatMessages.length > 200) {
        AppState.chatMessages = AppState.chatMessages.slice(-200);
    }

    storageUpdate(STORAGE_KEYS.CHAT_MSGS, () => AppState.chatMessages, []);

    renderizarTodasMensagens();
}

async function enviarMensagemChat(mensagem) {
    if (!mensagem.trim()) return;

    adicionarMensagemAoChat("user", mensagem);
    mostrarDigitacao("digitando");

    try {
        const baseCoren = await carregarConhecimentoCoren();
        await carregarConhecimentoChat();
        let resposta = await gerarRespostaChat(mensagem, baseCoren);
        removerDigitacao();
        adicionarMensagemAoChat("assistant", resposta);
    } catch (error) {
        removerDigitacao();
        adicionarMensagemAoChat("assistant", "❌ Erro ao processar sua mensagem. Tente novamente.");
        console.error("[Chatplay Assistant] ❌ Erro no chat:", error);
    }
}


/** @namespace ChatEngine — ponto de acesso público do módulo */
const ChatEngine = {
    adicionarMensagemAoChat,
    enviarMensagemChat,
};

/* ══════════════════════════════════════════════════════════════
   [M9] MODULE: UI
   Design system, painéis, renderização, toasts e modais. VERSÃO v8 (enterprise).
   Migração futura: Separar em componentes Web Components / React para a extensão
══════════════════════════════════════════════════════════════ */

function adicionarAnimacoesCSS() {
    if (document.getElementById("cpa-design-system")) return;
    const style = document.createElement("style");
    style.id = "cpa-design-system";
    style.textContent = `
        /* ── DESIGN TOKENS ────────────────────────────────── */
        :root {
            /* Cores base – escala cinza frio */
            --cpa-bg-0:       #080a0f;
            --cpa-bg-1:       #0d1117;
            --cpa-bg-2:       #161b22;
            --cpa-bg-3:       #1c2230;
            --cpa-bg-4:       #243040;
            --cpa-border:     #21293a;
            --cpa-border-hi:  #2d3a4f;

            /* Primária – azul índigo corporativo */
            --cpa-primary:        #4f6af5;
            --cpa-primary-hover:  #3d56e0;
            --cpa-primary-muted:  rgba(79,106,245,.12);
            --cpa-primary-ring:   rgba(79,106,245,.35);

            /* Apoio – verde esmeralda */
            --cpa-accent:         #34d399;
            --cpa-accent-hover:   #10b981;
            --cpa-accent-muted:   rgba(52,211,153,.12);

            /* Semânticas */
            --cpa-success:        #22c55e;
            --cpa-success-muted:  rgba(34,197,94,.12);
            --cpa-warning:        #f59e0b;
            --cpa-warning-muted:  rgba(245,158,11,.12);
            --cpa-danger:         #f04343;
            --cpa-danger-hover:   #dc2626;
            --cpa-danger-muted:   rgba(240,67,67,.12);

            /* Texto */
            --cpa-text-1:   #e6ecf4;
            --cpa-text-2:   #8fa3bf;
            --cpa-text-3:   #546880;
            --cpa-text-inv: #0d1117;

            /* Tipografia */
            --cpa-font:     -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', system-ui, sans-serif;
            --cpa-font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;

            --cpa-text-xs:   11px;
            --cpa-text-sm:   12px;
            --cpa-text-base: 13px;
            --cpa-text-md:   14px;
            --cpa-text-lg:   16px;
            --cpa-text-xl:   18px;

            --cpa-fw-normal: 400;
            --cpa-fw-medium: 500;
            --cpa-fw-semi:   600;
            --cpa-fw-bold:   700;

            --cpa-lh:   1.55;

            /* Espaçamento 4pt */
            --cpa-sp-1: 4px;
            --cpa-sp-2: 8px;
            --cpa-sp-3: 12px;
            --cpa-sp-4: 16px;
            --cpa-sp-5: 20px;
            --cpa-sp-6: 24px;
            --cpa-sp-8: 32px;

            /* Borda */
            --cpa-r-sm:  4px;
            --cpa-r-md:  6px;
            --cpa-r-lg:  10px;
            --cpa-r-xl:  14px;
            --cpa-r-2xl: 20px;
            --cpa-r-full: 9999px;

            /* Sombras */
            --cpa-shadow-sm:  0 1px 3px rgba(0,0,0,.4);
            --cpa-shadow-md:  0 4px 12px rgba(0,0,0,.45);
            --cpa-shadow-lg:  0 8px 32px rgba(0,0,0,.55);
            --cpa-shadow-xl:  0 16px 48px rgba(0,0,0,.65);
            --cpa-shadow-pri: 0 0 0 3px var(--cpa-primary-ring);

            /* Motion */
            --cpa-dur-fast: 120ms;
            --cpa-dur-base: 180ms;
            --cpa-dur-slow: 260ms;
            --cpa-ease:     cubic-bezier(.4,0,.2,1);
            --cpa-ease-out: cubic-bezier(0,0,.2,1);
        }

        /* ── ANIMAÇÕES ─────────────────────────────────────── */
        @keyframes cpa-fade-in {
            from { opacity:0; transform:translateY(6px); }
            to   { opacity:1; transform:translateY(0); }
        }
        @keyframes cpa-fade-in-scale {
            from { opacity:0; transform:translate(-50%,-50%) scale(.96); }
            to   { opacity:1; transform:translate(-50%,-50%) scale(1); }
        }
        @keyframes cpa-slide-up {
            from { opacity:0; transform:translateX(-50%) translateY(12px); }
            to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        @keyframes cpa-slide-down {
            from { opacity:1; transform:translateX(-50%) translateY(0); }
            to   { opacity:0; transform:translateX(-50%) translateY(12px); }
        }
        @keyframes cpa-spin {
            to { transform:rotate(360deg); }
        }
        @keyframes cpa-pulse-dot {
            0%,80%,100% { transform:scale(0.7); opacity:.4; }
            40% { transform:scale(1); opacity:1; }
        }
        @keyframes cpa-panel-in {
            from { opacity:0; transform:translateX(16px); }
            to   { opacity:1; transform:translateX(0); }
        }

        /* ── SCROLLBAR ──────────────────────────────────────── */
        .cpa-scroll::-webkit-scrollbar { width:4px; }
        .cpa-scroll::-webkit-scrollbar-track { background:transparent; }
        .cpa-scroll::-webkit-scrollbar-thumb {
            background: var(--cpa-border-hi);
            border-radius: var(--cpa-r-full);
        }
        .cpa-scroll::-webkit-scrollbar-thumb:hover { background: var(--cpa-primary); }

        /* ── RESET INTERNO ──────────────────────────────────── */
        .cpa-root * { box-sizing:border-box; margin:0; padding:0; }
        .cpa-root { font-family: var(--cpa-font); color: var(--cpa-text-1); }

        /* ── PAINEL PRINCIPAL (chat fixo) ───────────────────── */
        #ai-painel-fixo {
            position:fixed; top:20px; right:20px;
            width:360px; height:580px;
            background: var(--cpa-bg-1);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-xl);
            z-index:9999;
            display:flex; flex-direction:column;
            box-shadow: var(--cpa-shadow-xl);
            animation: cpa-panel-in var(--cpa-dur-slow) var(--cpa-ease-out) both;
            overflow:hidden;
        }

        /* ── HEADER DO PAINEL ──────────────────────────────── */
        .cpa-panel-header {
            display:flex; align-items:center; justify-content:space-between;
            padding: var(--cpa-sp-3) var(--cpa-sp-4);
            background: var(--cpa-bg-2);
            border-bottom: 1px solid var(--cpa-border);
            cursor:move; user-select:none;
            flex-shrink:0;
        }
        .cpa-panel-brand {
            display:flex; align-items:center; gap:var(--cpa-sp-2);
        }
        .cpa-panel-brand-icon {
            width:28px; height:28px; border-radius:var(--cpa-r-md);
            background: var(--cpa-primary-muted);
            display:flex; align-items:center; justify-content:center;
        }
        .cpa-panel-brand-name {
            font-size: var(--cpa-text-sm);
            font-weight: var(--cpa-fw-semi);
            color: var(--cpa-text-1);
            letter-spacing:.3px;
        }
        .cpa-panel-brand-version {
            font-size: var(--cpa-text-xs);
            color: var(--cpa-text-3);
            font-weight: var(--cpa-fw-normal);
            margin-left: 2px;
        }
        .cpa-panel-actions {
            display:flex; gap:var(--cpa-sp-1); align-items:center;
        }

        /* ── BOTÃO ÍCONE ──────────────────────────────────── */
        .cpa-icon-btn {
            width:28px; height:28px;
            background:transparent; border:none;
            border-radius: var(--cpa-r-md);
            color: var(--cpa-text-3);
            display:flex; align-items:center; justify-content:center;
            cursor:pointer; transition: background var(--cpa-dur-fast) var(--cpa-ease),
                                        color var(--cpa-dur-fast) var(--cpa-ease);
        }
        .cpa-icon-btn:hover { background: var(--cpa-bg-4); color: var(--cpa-text-1); }
        .cpa-icon-btn:active { background: var(--cpa-border-hi); }

        /* ── ÁREA DE MENSAGENS ─────────────────────────────── */
        .cpa-messages {
            flex:1; overflow-y:auto; padding: var(--cpa-sp-4);
            display:flex; flex-direction:column; gap:var(--cpa-sp-3);
            scroll-behavior:smooth; background: var(--cpa-bg-1);
        }

        /* ── MENSAGEM ─────────────────────────────────────── */
        .cpa-msg {
            display:flex; animation: cpa-fade-in var(--cpa-dur-base) var(--cpa-ease-out) both;
        }
        .cpa-msg--user   { justify-content:flex-end; }
        .cpa-msg--assistant { justify-content:flex-start; }

        .cpa-bubble {
            max-width:82%; font-size: var(--cpa-text-base);
            line-height: var(--cpa-lh); word-wrap:break-word;
            white-space:pre-wrap;
        }
        .cpa-bubble--user {
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-primary);
            color: #fff;
            border-radius: var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-sm) var(--cpa-r-lg);
        }
        .cpa-bubble--assistant {
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-3);
            color: var(--cpa-text-1);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-sm);
        }

        /* ── CARDS DE SUGESTÃO ────────────────────────────── */
        .cpa-suggestions-wrap {
            background: var(--cpa-bg-3);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-sm);
            padding: var(--cpa-sp-3);
            max-width:90%;
        }
        .cpa-suggestions-label {
            font-size: var(--cpa-text-xs);
            font-weight: var(--cpa-fw-semi);
            color: var(--cpa-accent);
            letter-spacing:.5px;
            text-transform:uppercase;
            margin-bottom: var(--cpa-sp-3);
            display:flex; align-items:center; gap:var(--cpa-sp-1);
        }
        .cpa-sug-item {
            display:flex; align-items:flex-start; gap:var(--cpa-sp-2);
            margin-bottom: var(--cpa-sp-2);
        }
        .cpa-sug-item:last-child { margin-bottom:0; }
        .cpa-sug-btn {
            flex:1; text-align:left;
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-2);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md);
            color: var(--cpa-text-1);
            font-size: var(--cpa-text-sm);
            line-height: var(--cpa-lh);
            cursor:pointer; white-space:normal;
            transition: background var(--cpa-dur-fast) var(--cpa-ease),
                        border-color var(--cpa-dur-fast) var(--cpa-ease),
                        transform var(--cpa-dur-fast) var(--cpa-ease);
            font-family: var(--cpa-font);
        }
        .cpa-sug-btn:hover {
            background: var(--cpa-bg-4);
            border-color: var(--cpa-primary);
            transform: translateX(2px);
        }
        .cpa-sug-btn.cpa-sug-btn--selected {
            background: var(--cpa-primary-muted);
            border-color: var(--cpa-primary);
            color: #fff;
        }
        .cpa-sug-num {
            flex-shrink:0;
            font-size: var(--cpa-text-xs);
            color: var(--cpa-text-3);
            font-weight: var(--cpa-fw-semi);
            margin-top: 5px;
            min-width:14px;
        }
        .cpa-sug-reject {
            flex-shrink:0; width:22px; height:22px;
            background:transparent; border:none;
            border-radius: var(--cpa-r-sm);
            color: var(--cpa-text-3); cursor:pointer;
            display:flex; align-items:center; justify-content:center;
            font-size:11px; margin-top:3px;
            transition: color var(--cpa-dur-fast), background var(--cpa-dur-fast);
        }
        .cpa-sug-reject:hover { color: var(--cpa-danger); background: var(--cpa-danger-muted); }

        /* ── INDICADOR DE DIGITAÇÃO ───────────────────────── */
        .cpa-typing {
            display:flex; justify-content:flex-start;
            animation: cpa-fade-in var(--cpa-dur-base) var(--cpa-ease-out) both;
        }
        .cpa-typing-bubble {
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-3);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-lg) var(--cpa-r-sm);
            display:flex; align-items:center; gap:var(--cpa-sp-2);
            font-size: var(--cpa-text-sm);
            color: var(--cpa-text-3);
        }
        .cpa-typing-dots { display:flex; gap:3px; }
        .cpa-typing-dot {
            width:4px; height:4px; border-radius:50%;
            background: var(--cpa-text-3);
            animation: cpa-pulse-dot 1.2s infinite;
        }
        .cpa-typing-dot:nth-child(2) { animation-delay:.2s; }
        .cpa-typing-dot:nth-child(3) { animation-delay:.4s; }

        /* ── INPUT AREA ───────────────────────────────────── */
        .cpa-input-area {
            flex-shrink:0;
            padding: var(--cpa-sp-3) var(--cpa-sp-4);
            background: var(--cpa-bg-2);
            border-top: 1px solid var(--cpa-border);
        }
        .cpa-input-row {
            display:flex; gap:var(--cpa-sp-2);
            margin-bottom: var(--cpa-sp-2);
            align-items:flex-end;
        }
        .cpa-textarea {
            flex:1; padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-1);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md);
            color: var(--cpa-text-1);
            font-size: var(--cpa-text-base);
            font-family: var(--cpa-font);
            resize:none; min-height:36px; max-height:100px;
            line-height: var(--cpa-lh);
            transition: border-color var(--cpa-dur-fast) var(--cpa-ease),
                        box-shadow var(--cpa-dur-fast) var(--cpa-ease);
            outline:none;
        }
        .cpa-textarea::placeholder { color: var(--cpa-text-3); }
        .cpa-textarea:focus {
            border-color: var(--cpa-primary);
            box-shadow: 0 0 0 2px var(--cpa-primary-ring);
        }

        /* ── BOTÕES ───────────────────────────────────────── */
        .cpa-btn {
            display:inline-flex; align-items:center; justify-content:center;
            gap: var(--cpa-sp-1);
            font-size: var(--cpa-text-sm);
            font-weight: var(--cpa-fw-semi);
            font-family: var(--cpa-font);
            border:none; cursor:pointer;
            border-radius: var(--cpa-r-md);
            transition: background var(--cpa-dur-fast) var(--cpa-ease),
                        box-shadow var(--cpa-dur-fast) var(--cpa-ease),
                        transform var(--cpa-dur-fast) var(--cpa-ease);
            white-space:nowrap;
        }
        .cpa-btn:active { transform:translateY(1px); }

        .cpa-btn--primary {
            background: var(--cpa-primary); color:#fff;
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
        }
        .cpa-btn--primary:hover { background: var(--cpa-primary-hover); }

        .cpa-btn--accent {
            background: var(--cpa-accent-muted); color: var(--cpa-accent);
            border: 1px solid rgba(52,211,153,.2);
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
        }
        .cpa-btn--accent:hover { background: rgba(52,211,153,.2); }

        .cpa-btn--ghost {
            background:transparent; color: var(--cpa-text-2);
            border: 1px solid var(--cpa-border);
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
        }
        .cpa-btn--ghost:hover { background: var(--cpa-bg-3); color: var(--cpa-text-1); }

        .cpa-btn--danger {
            background: var(--cpa-danger-muted); color: var(--cpa-danger);
            border: 1px solid rgba(240,67,67,.2);
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
        }
        .cpa-btn--danger:hover { background: rgba(240,67,67,.2); }

        .cpa-btn--sm { padding: var(--cpa-sp-1) var(--cpa-sp-2); font-size: var(--cpa-text-xs); }
        .cpa-btn--full { width:100%; }

        .cpa-btn-row {
            display:flex; gap:var(--cpa-sp-2);
        }

        /* ── BOTÃO FLUTUANTE ──────────────────────────────── */
        #ai-botao-principal {
            position:fixed; bottom:24px; right:24px; z-index:9998;
        }
        .cpa-fab {
            width:48px; height:48px;
            background: var(--cpa-bg-2);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-2xl);
            display:flex; align-items:center; justify-content:center;
            cursor:pointer; position:relative;
            box-shadow: 0 4px 16px rgba(79,106,245,.25);
            transition: transform var(--cpa-dur-base) var(--cpa-ease),
                        box-shadow var(--cpa-dur-base) var(--cpa-ease),
                        background var(--cpa-dur-base) var(--cpa-ease);
        }
        .cpa-fab:hover {
            transform:translateY(-2px) scale(1.05);
            box-shadow: 0 6px 20px rgba(79,106,245,.38);
            background: var(--cpa-bg-3);
        }
        .cpa-fab-tooltip {
            position:absolute; right:56px;
            background: var(--cpa-bg-3);
            color: var(--cpa-text-1);
            border: 1px solid var(--cpa-border);
            padding: var(--cpa-sp-1) var(--cpa-sp-3);
            border-radius: var(--cpa-r-md);
            font-size: var(--cpa-text-xs);
            white-space:nowrap;
            box-shadow: var(--cpa-shadow-md);
            opacity:0; pointer-events:none;
            transition: opacity var(--cpa-dur-base) var(--cpa-ease);
            font-family: var(--cpa-font);
        }
        .cpa-fab:hover .cpa-fab-tooltip { opacity:1; }

        /* ── TOAST ────────────────────────────────────────── */
        .cpa-toast {
            position:fixed; bottom:24px; left:50%;
            transform:translateX(-50%);
            display:flex; align-items:center; gap:var(--cpa-sp-2);
            padding: var(--cpa-sp-2) var(--cpa-sp-4);
            border-radius: var(--cpa-r-lg);
            font-size: var(--cpa-text-sm);
            font-weight: var(--cpa-fw-medium);
            font-family: var(--cpa-font);
            z-index:100000;
            box-shadow: var(--cpa-shadow-lg);
            animation: cpa-slide-up var(--cpa-dur-base) var(--cpa-ease-out) both;
            max-width:360px;
        }
        .cpa-toast--success { background: var(--cpa-success-muted); color: var(--cpa-success); border:1px solid rgba(34,197,94,.2); }
        .cpa-toast--info    { background: var(--cpa-primary-muted);  color: var(--cpa-primary);  border:1px solid rgba(79,106,245,.2); }
        .cpa-toast--warning { background: var(--cpa-warning-muted);  color: var(--cpa-warning);  border:1px solid rgba(245,158,11,.2); }
        .cpa-toast--error   { background: var(--cpa-danger-muted);   color: var(--cpa-danger);   border:1px solid rgba(240,67,67,.2); }
        .cpa-toast--out { animation: cpa-slide-down var(--cpa-dur-base) var(--cpa-ease) both; }

        /* ── PAINEL PROFISSIONAL (modal) ──────────────────── */
        #ai-painel-profissional {
            position:fixed; top:50%; left:50%;
            transform:translate(-50%,-50%);
            width:680px; max-width:94vw;
            background: var(--cpa-bg-1);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-xl);
            box-shadow: var(--cpa-shadow-xl);
            z-index:100000; overflow:hidden;
            display:flex; flex-direction:column;
            max-height:86vh;
            animation: cpa-fade-in-scale var(--cpa-dur-slow) var(--cpa-ease-out) both;
        }
        .cpa-modal-backdrop {
            position:fixed; inset:0;
            background:rgba(0,0,0,.6);
            backdrop-filter:blur(4px);
            z-index:99999;
            animation: cpa-fade-in var(--cpa-dur-base) var(--cpa-ease-out) both;
        }
        .cpa-modal-header {
            display:flex; align-items:center; justify-content:space-between;
            padding: var(--cpa-sp-4) var(--cpa-sp-5);
            background: var(--cpa-bg-2);
            border-bottom: 1px solid var(--cpa-border);
            flex-shrink:0;
        }
        .cpa-modal-title {
            font-size: var(--cpa-text-md);
            font-weight: var(--cpa-fw-semi);
            color: var(--cpa-text-1);
            display:flex; align-items:center; gap:var(--cpa-sp-2);
        }
        .cpa-modal-title-dot {
            width:6px; height:6px; border-radius:50%;
            background: var(--cpa-primary); flex-shrink:0;
        }

        /* ── TABS ─────────────────────────────────────────── */
        .cpa-tabs {
            display:flex; gap:2px;
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-2);
            border-bottom: 1px solid var(--cpa-border);
            flex-shrink:0; overflow-x:auto;
        }
        .cpa-tabs::-webkit-scrollbar { display:none; }
        .cpa-tab {
            display:flex; align-items:center; gap:var(--cpa-sp-1);
            padding: var(--cpa-sp-1) var(--cpa-sp-3);
            font-size: var(--cpa-text-sm);
            font-weight: var(--cpa-fw-medium);
            color: var(--cpa-text-3);
            background:transparent; border:none;
            border-radius: var(--cpa-r-md);
            cursor:pointer; white-space:nowrap;
            font-family: var(--cpa-font);
            transition: color var(--cpa-dur-fast), background var(--cpa-dur-fast);
        }
        .cpa-tab:hover { color: var(--cpa-text-1); background: var(--cpa-bg-3); }
        .cpa-tab.cpa-tab--active {
            color: var(--cpa-text-1);
            background: var(--cpa-primary-muted);
            font-weight: var(--cpa-fw-semi);
        }

        /* ── CONTEÚDO DAS ABAS ────────────────────────────── */
        .cpa-tab-content {
            flex:1; overflow-y:auto;
            padding: var(--cpa-sp-5);
            background: var(--cpa-bg-1);
        }
        .tab-content { display:none; }

        /* ── GRADE DE STATS ───────────────────────────────── */
        .cpa-stats-grid {
            display:grid; gap:var(--cpa-sp-3);
            margin-bottom: var(--cpa-sp-5);
        }
        .cpa-stats-grid--4 { grid-template-columns:repeat(4,1fr); }
        .cpa-stats-grid--3 { grid-template-columns:repeat(3,1fr); }
        .cpa-stats-grid--2 { grid-template-columns:repeat(2,1fr); }

        .cpa-stat-card {
            background: var(--cpa-bg-2);
            border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg);
            padding: var(--cpa-sp-3) var(--cpa-sp-4);
        }
        .cpa-stat-label {
            font-size: var(--cpa-text-xs);
            color: var(--cpa-text-3);
            margin-bottom: var(--cpa-sp-1);
            font-weight: var(--cpa-fw-medium);
            text-transform:uppercase; letter-spacing:.4px;
        }
        .cpa-stat-val {
            font-size: var(--cpa-text-xl);
            font-weight: var(--cpa-fw-bold);
            line-height:1.2;
        }
        .cpa-stat-val--primary  { color: var(--cpa-primary); }
        .cpa-stat-val--success  { color: var(--cpa-success); }
        .cpa-stat-val--warning  { color: var(--cpa-warning); }
        .cpa-stat-val--danger   { color: var(--cpa-danger); }
        .cpa-stat-val--accent   { color: var(--cpa-accent); }

        /* ── CAMPO DE BUSCA ───────────────────────────────── */
        .cpa-search {
            width:100%; padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md);
            color: var(--cpa-text-1); font-size: var(--cpa-text-base);
            font-family: var(--cpa-font); outline:none;
            margin-bottom: var(--cpa-sp-4);
            transition: border-color var(--cpa-dur-fast), box-shadow var(--cpa-dur-fast);
        }
        .cpa-search::placeholder { color: var(--cpa-text-3); }
        .cpa-search:focus {
            border-color: var(--cpa-primary);
            box-shadow: 0 0 0 2px var(--cpa-primary-ring);
        }

        /* ── LISTA HISTÓRICO ──────────────────────────────── */
        .cpa-history-list { display:flex; flex-direction:column; gap:var(--cpa-sp-2); }
        .cpa-history-card {
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg); padding: var(--cpa-sp-3) var(--cpa-sp-4);
            border-left:3px solid transparent; position:relative;
            transition: border-color var(--cpa-dur-fast);
        }
        .cpa-history-card:hover { border-color: var(--cpa-primary); }
        .cpa-history-card-header {
            display:flex; align-items:center; justify-content:space-between;
            margin-bottom: var(--cpa-sp-2); padding-right: 32px;
        }
        .cpa-history-question {
            font-size: var(--cpa-text-sm); color: var(--cpa-text-2);
            margin-bottom: var(--cpa-sp-2);
            padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-1);
            border-radius: var(--cpa-r-md);
            border-left: 2px solid var(--cpa-border-hi);
        }
        .cpa-history-responses { display:flex; flex-direction:column; gap:var(--cpa-sp-1); }
        .cpa-history-resp-btn {
            width:100%; text-align:left; padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-1); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md); color: var(--cpa-text-1);
            font-size: var(--cpa-text-sm); cursor:pointer;
            font-family: var(--cpa-font);
            transition: background var(--cpa-dur-fast), border-color var(--cpa-dur-fast);
        }
        .cpa-history-resp-btn:hover { background: var(--cpa-bg-3); border-color: var(--cpa-primary); }

        /* ── BADGE / CATEGORIA ────────────────────────────── */
        .cpa-badge {
            display:inline-flex; align-items:center;
            padding: 2px var(--cpa-sp-2);
            border-radius: var(--cpa-r-sm);
            font-size: var(--cpa-text-xs); font-weight: var(--cpa-fw-semi);
            line-height:1.4;
        }
        .cpa-date {
            font-size: var(--cpa-text-xs); color: var(--cpa-text-3);
        }

        /* ── BOTÃO EXCLUIR INLINE ─────────────────────────── */
        .cpa-delete-btn {
            position:absolute; top: var(--cpa-sp-3); right: var(--cpa-sp-3);
            width:24px; height:24px; background:transparent; border:none;
            border-radius: var(--cpa-r-sm); cursor:pointer;
            color: var(--cpa-text-3); display:flex; align-items:center; justify-content:center;
            font-size:12px;
            transition: color var(--cpa-dur-fast), background var(--cpa-dur-fast);
        }
        .cpa-delete-btn:hover { color: var(--cpa-danger); background: var(--cpa-danger-muted); }

        /* ── SEÇÃO ────────────────────────────────────────── */
        .cpa-section {
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-lg); padding: var(--cpa-sp-4);
            margin-bottom: var(--cpa-sp-4);
        }
        .cpa-section-title {
            font-size: var(--cpa-text-sm); font-weight: var(--cpa-fw-semi);
            color: var(--cpa-text-2); margin-bottom: var(--cpa-sp-3);
            text-transform:uppercase; letter-spacing:.4px;
        }

        /* ── TOGGLE / CHECKBOX ────────────────────────────── */
        .cpa-pref-row {
            display:flex; align-items:center; justify-content:space-between;
            padding: var(--cpa-sp-2) 0;
            border-bottom: 1px solid var(--cpa-border);
        }
        .cpa-pref-row:last-child { border-bottom:none; }
        .cpa-pref-label {
            font-size: var(--cpa-text-base); color: var(--cpa-text-1);
        }
        .cpa-toggle {
            appearance:none; width:36px; height:20px;
            background: var(--cpa-border-hi); border-radius: var(--cpa-r-full);
            cursor:pointer; position:relative;
            transition: background var(--cpa-dur-base);
        }
        .cpa-toggle::after {
            content:''; position:absolute; top:2px; left:2px;
            width:16px; height:16px; border-radius:50%;
            background:#fff; transition: transform var(--cpa-dur-base) var(--cpa-ease);
        }
        .cpa-toggle:checked { background: var(--cpa-primary); }
        .cpa-toggle:checked::after { transform:translateX(16px); }

        /* ── INPUT MODAL ──────────────────────────────────── */
        .cpa-input {
            width:100%; padding: var(--cpa-sp-2) var(--cpa-sp-3);
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md);
            color: var(--cpa-text-1); font-size: var(--cpa-text-base);
            font-family: var(--cpa-font); outline:none;
            transition: border-color var(--cpa-dur-fast), box-shadow var(--cpa-dur-fast);
        }
        .cpa-input--mono { font-family: var(--cpa-font-mono); }
        .cpa-input:focus {
            border-color: var(--cpa-primary);
            box-shadow: 0 0 0 2px var(--cpa-primary-ring);
        }
        .cpa-input--error { border-color: var(--cpa-danger) !important; }

        /* ── PADRÕES DESAPROVADOS ─────────────────────────── */
        .cpa-pattern-wrap { display:flex; flex-wrap:wrap; gap:var(--cpa-sp-1); margin-bottom: var(--cpa-sp-4); }
        .cpa-pattern-badge {
            background: var(--cpa-danger-muted);
            color: var(--cpa-danger);
            border: 1px solid rgba(240,67,67,.2);
            padding: 2px var(--cpa-sp-2);
            border-radius: var(--cpa-r-full);
            font-size: var(--cpa-text-xs); font-weight: var(--cpa-fw-medium);
        }

        /* ── CARD DESAPROVADO ─────────────────────────────── */
        .cpa-discard-card {
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-left: 3px solid var(--cpa-danger);
            border-radius: var(--cpa-r-lg); padding: var(--cpa-sp-3) var(--cpa-sp-4);
            position:relative; margin-bottom: var(--cpa-sp-2);
        }

        /* ── FOOTER DO MODAL ──────────────────────────────── */
        .cpa-modal-footer {
            display:flex; justify-content:flex-end; gap: var(--cpa-sp-2);
            padding: var(--cpa-sp-3) var(--cpa-sp-5);
            background: var(--cpa-bg-2);
            border-top: 1px solid var(--cpa-border);
            flex-shrink:0;
        }

        /* ── EMPTY STATE ──────────────────────────────────── */
        .cpa-empty {
            text-align:center; padding: var(--cpa-sp-8);
            color: var(--cpa-text-3);
        }
        .cpa-empty-icon { font-size:28px; margin-bottom: var(--cpa-sp-3); opacity:.5; }
        .cpa-empty-text { font-size: var(--cpa-text-sm); }
        .cpa-empty-hint { font-size: var(--cpa-text-xs); margin-top: var(--cpa-sp-2); color: var(--cpa-text-3); }

        /* ── CATEGORY BLOCK ───────────────────────────────── */
        .cpa-cat-block { margin-bottom: var(--cpa-sp-5); }
        .cpa-cat-title {
            display:flex; align-items:center; justify-content:space-between;
            font-size: var(--cpa-text-xs); font-weight: var(--cpa-fw-semi);
            text-transform:uppercase; letter-spacing:.5px;
            margin-bottom: var(--cpa-sp-2); padding-bottom: var(--cpa-sp-2);
            border-bottom: 1px solid var(--cpa-border);
        }
        .cpa-cat-counters { display:flex; gap:var(--cpa-sp-3); }
        .cpa-cat-counter { font-size: var(--cpa-text-xs); font-weight: var(--cpa-fw-medium); }

        /* ── LOG ITEM ─────────────────────────────────────── */
        .cpa-log-item {
            background: var(--cpa-bg-2); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-md); padding: var(--cpa-sp-3);
            margin-bottom: var(--cpa-sp-2);
        }
        .cpa-log-meta {
            font-size: var(--cpa-text-xs); color: var(--cpa-text-3);
            margin-bottom: var(--cpa-sp-1);
        }
        .cpa-log-quote {
            font-size: var(--cpa-text-xs); color: var(--cpa-text-2);
            font-style:italic; margin-bottom: var(--cpa-sp-2);
        }

        /* ── MODAL SIMPLES ────────────────────────────────── */
        .cpa-modal-simple {
            position:fixed; top:50%; left:50%;
            transform:translate(-50%,-50%);
            background: var(--cpa-bg-1); border: 1px solid var(--cpa-border);
            border-radius: var(--cpa-r-xl); padding: var(--cpa-sp-6);
            width:400px; max-width:92vw; z-index:1000001;
            box-shadow: var(--cpa-shadow-xl);
            animation: cpa-fade-in-scale var(--cpa-dur-slow) var(--cpa-ease-out) both;
        }
        .cpa-modal-simple-title {
            font-size: var(--cpa-text-lg); font-weight: var(--cpa-fw-semi);
            color: var(--cpa-text-1); margin-bottom: var(--cpa-sp-3);
        }
        .cpa-modal-simple-desc {
            font-size: var(--cpa-text-sm); color: var(--cpa-text-2);
            margin-bottom: var(--cpa-sp-4); line-height: var(--cpa-lh);
        }

        /* ── DROPDOWN LIMPEZA ─────────────────────────────── */
        .cpa-clean-btn {
            width:100%; margin-bottom: var(--cpa-sp-2);
        }

        /* ── TOOLTIP ──────────────────────────────────────── */
        [data-cpa-tooltip] { position:relative; }
        [data-cpa-tooltip]:hover::after {
            content: attr(data-cpa-tooltip);
            position:absolute; bottom:calc(100% + 6px); left:50%;
            transform:translateX(-50%);
            background: var(--cpa-bg-4); color: var(--cpa-text-1);
            font-size: var(--cpa-text-xs); font-family: var(--cpa-font);
            padding: 3px var(--cpa-sp-2); border-radius: var(--cpa-r-sm);
            white-space:nowrap; pointer-events:none; z-index:10;
            border: 1px solid var(--cpa-border);
        }
    `;
    document.head.appendChild(style);
}

function getCorCategoria(cat, bg = false) {
    const m = {
        CANCELAMENTO:  { c:'#f87171', b:'rgba(248,113,113,.12)' },
        SUSPENSAO:     { c:'#fb923c', b:'rgba(251,146,60,.12)'  },
        NEGOCIACAO:    { c:'#34d399', b:'rgba(52,211,153,.12)'  },
        NADA_CONSTA:   { c:'#60a5fa', b:'rgba(96,165,250,.12)'  },
        GOLPE:         { c:'#a78bfa', b:'rgba(167,139,250,.12)' },
        PRAZO:         { c:'#f472b6', b:'rgba(244,114,182,.12)' },
        SEM_DINHEIRO:  { c:'#fbbf24', b:'rgba(251,191,36,.12)'  },
        DUVIDA:        { c:'#67e8f9', b:'rgba(103,232,249,.12)' },
        RECLAMACAO:    { c:'#f87171', b:'rgba(248,113,113,.12)' },
        OUTROS:        { c:'#6b7280', b:'rgba(107,114,128,.12)' }
    };
    const def = { c:'#6b7280', b:'rgba(107,114,128,.12)' };
    const t = (m[cat] || def);
    return bg ? t.b : t.c;
}

function renderizarMensagemNoChat(role, conteudo, tipo = "texto", meta = undefined) {
    const container = document.getElementById("chat-messages-container");
    if (!container) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = `cpa-msg cpa-msg--${role}`;

    if (tipo === "sugestoes") {
        let sugestoes;
        try { sugestoes = JSON.parse(conteudo); } catch { sugestoes = [conteudo]; }

        const wrap = document.createElement("div");
        wrap.className = "cpa-suggestions-wrap";
        wrap.innerHTML = `<div class="cpa-suggestions-label">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Sugestões de resposta
        </div>`;

        if (meta?.source === "history") {
            const info = document.createElement("div");
            info.style.cssText = "margin:6px 0 10px;font-size:var(--cpa-text-xs);color:var(--cpa-text-2)";
            info.textContent = "Estas sugestões foram reutilizadas do histórico.";
            wrap.appendChild(info);
        }

        sugestoes.forEach((sug, i) => {
            const row = document.createElement("div");
            row.className = "cpa-sug-item";

            const num = document.createElement("span");
            num.className = "cpa-sug-num";
            num.textContent = `${i+1}`;

            const btn = document.createElement("button");
            btn.className = "cpa-sug-btn";
            btn.textContent = sug;
            // ── Lock de duplo clique por sugestão ──────────────────────────
            let _feedbackSent_used = false;
            btn.onclick = () => {
                if (sugestaoSelecionadaAtual && sugestaoSelecionadaAtual !== btn) {
                    sugestaoSelecionadaAtual.classList.remove("cpa-sug-btn--selected");
                }
                sugestaoSelecionadaAtual = btn;
                btn.classList.add("cpa-sug-btn--selected");
                AppState.sugestaoAtual = sug;
                const cat = classificarIntencao(AppState.ultimaPergunta || "");

                // Idempotência: salvar no log apenas uma vez por sugestão selecionada
                const sugNorm = sug.trim();
                const idx = (AppState._lastSuggestions || []).findIndex(s => s.trim() === sugNorm);
                const sid = idx >= 0 ? (AppState._lastSuggestionIds?.[idx] || null) : null;

                salvarSugestaoNoLog(sug, AppState.ultimaPergunta || "", cat, sid);
                inserirNoCampoChatPlay(sug);

                // ── Backend: registrar feedback USED — apenas 1x por sugestão ──
                if (!_feedbackSent_used && CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN) {
                    _feedbackSent_used = true;
                    atualizarScoreResposta(sug, cat, true);
                    BackendAPI.logEvent('suggestion.used', {
                        category: cat,
                        preview:  sug.substring(0, 80),
                    });
                    if (sid) {
                        BackendAPI.sendFeedback(sid, 'USED').catch(err => {
                            console.warn('[Chatplay] feedback USED ignorado:', err.message);
                            _feedbackSent_used = false; // permite retry em falha de rede
                        });
                    }
                }
            };

            const reject = document.createElement("button");
            reject.className = "cpa-sug-reject";
            reject.title = "Marcar como inadequada";
            reject.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
            let _feedbackSent_rej = false;
            reject.onclick = (e) => {
                e.stopPropagation();
                if (_feedbackSent_rej) return; // evita duplo clique
                _feedbackSent_rej = true;

                const cat = classificarIntencao(AppState.ultimaPergunta || "");
                const sugNorm = sug.trim();
                const idxR = (AppState._lastSuggestions || []).findIndex(s => s.trim() === sugNorm);
                const sidR = idxR >= 0 ? (AppState._lastSuggestionIds?.[idxR] || null) : null;

                registrarRespostaDesaprovada(sug, AppState.ultimaPergunta || "", cat, "", sidR);
                row.remove();

                // ── Backend: registrar feedback REJECTED — apenas 1x ──────
                if (CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN) {
                    atualizarScoreResposta(sug, cat, false);
                    BackendAPI.logEvent('suggestion.rejected', {
                        category: cat,
                        preview:  sug.substring(0, 80),
                    });
                    if (sidR) {
                        BackendAPI.sendFeedback(sidR, 'REJECTED').catch(err => {
                            console.warn('[Chatplay] feedback REJECTED ignorado:', err.message);
                            _feedbackSent_rej = false;
                        });
                    }
                }
            };

            row.appendChild(num);
            row.appendChild(btn);
            row.appendChild(reject);
            wrap.appendChild(row);
        });

        if (meta?.source === "history") {
            const regen = document.createElement("button");
            regen.className = "cpa-btn cpa-btn--ghost cpa-btn--full";
            regen.style.marginTop = "10px";
            regen.textContent = "Gerar novas sugestões";

            regen.onclick = async () => {
                if (!meta?.context || !meta?.question) return;
                regen.disabled = true;
                regen.style.opacity = ".6";
                regen.textContent = "Gerando...";
                try {
                    const novas = await gerarRespostasIA(meta.context, meta.question);
                    if (novas && novas.length > 0) {
                        AppState.ultimaPergunta = meta.question;
                        adicionarMensagemAoChat("assistant", JSON.stringify(novas), "sugestoes", {
                            source: "fresh",
                            question: meta.question,
                            context: meta.context,
                            category: meta.category,
                        });
                        salvarNoHistorico(meta.question, novas, meta.context);
                    } else {
                        mostrarNotificacao("❌ Falha ao gerar novas sugestões", "erro");
                    }
                } catch (err) {
                    console.error("[Chatplay Assistant] ❌ Erro:", err);
                    mostrarNotificacao("❌ Erro ao gerar novas sugestões", "erro");
                } finally {
                    regen.disabled = false;
                    regen.style.opacity = "1";
                    regen.textContent = "Gerar novas sugestões";
                }
            };

            wrap.appendChild(regen);
        }

        msgDiv.appendChild(wrap);
    } else {
        const bubble = document.createElement("div");
        bubble.className = `cpa-bubble cpa-bubble--${role}`;
        bubble.innerHTML = conteudo.replace(/\n/g, "<br>");
        msgDiv.appendChild(bubble);
    }

    container.appendChild(msgDiv);
}

function renderizarTodasMensagens() {
    const container = document.getElementById("chat-messages-container");
    if (!container) return;
    container.innerHTML = "";
    AppState.chatMessages.forEach(msg => renderizarMensagemNoChat(msg.role, msg.content, msg.tipo, msg.meta));
    container.scrollTop = container.scrollHeight;
}

function mostrarDigitacao(tipo = "digitando") {
    const container = document.getElementById("chat-messages-container");
    if (!container) return;
    removerDigitacao();

    const wrap = document.createElement("div");
    wrap.id = "typing-indicator";
    wrap.className = "cpa-typing";

    const label = tipo === "sugestoes" ? "Gerando sugestões" : "Digitando";
    wrap.innerHTML = `
        <div class="cpa-typing-bubble">
            <span style="font-size:var(--cpa-text-xs);color:var(--cpa-text-3)">${label}</span>
            <div class="cpa-typing-dots">
                <div class="cpa-typing-dot"></div>
                <div class="cpa-typing-dot"></div>
                <div class="cpa-typing-dot"></div>
            </div>
        </div>
    `;
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
}

function removerDigitacao() {
    document.getElementById("typing-indicator")?.remove();
}

function mostrarNotificacao(mensagem, tipo = "info") {
    if (!AppState.preferencias.notificacoes && tipo !== "erro") return;

    const map = { "sucesso":"success", "success":"success", "aviso":"warning", "warning":"warning", "erro":"error", "error":"error", "info":"info" };
    const cls = map[tipo] || "info";

    const icons = {
        success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        warning: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        error: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
        info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
    };

    // Remove toast anterior
    document.querySelectorAll(".cpa-toast").forEach(t => t.remove());

    const toast = document.createElement("div");
    toast.className = `cpa-toast cpa-root cpa-toast--${cls}`;
    toast.innerHTML = `${icons[cls]}<span>${mensagem}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("cpa-toast--out");
        setTimeout(() => toast.remove(), 260);
    }, 3000);
}

function criarBotaoAcao(texto, tipo, onClick) {
    const map = { danger:"cpa-btn--danger", secondary:"cpa-btn--ghost", primary:"cpa-btn--primary" };
    const btn = document.createElement("button");
    btn.className = `cpa-btn ${map[tipo] || "cpa-btn--ghost"}`;
    btn.textContent = texto;
    btn.onclick = onClick;
    return btn;
}

function criarBotaoPrincipal() {
    document.getElementById("ai-botao-principal")?.remove();

    const container = document.createElement("div");
    container.id = "ai-botao-principal";
    container.setAttribute("data-chatplay-toggle", "true"); // seletor padronizado para content_script.js
    container.className = "cpa-root";

    const fab = document.createElement("button");
    fab.className = "cpa-fab";
    fab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--cpa-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="cpa-fab-tooltip">Abrir Assistente (ALT+1)</span>
    `;

    fab.onclick = () => { container.remove(); criarPainelFixo(); };
    container.appendChild(fab);
    document.body.appendChild(container);
}

function criarPainelFixo() {
    document.getElementById("ai-painel-fixo")?.remove();

    const painel = document.createElement("div");
    painel.id = "ai-painel-fixo";
    painel.className = "cpa-root";

    /* HEADER */
    const header = document.createElement("div");
    header.className = "cpa-panel-header";

    const brand = document.createElement("div");
    brand.className = "cpa-panel-brand";
    brand.innerHTML = `
        <div class="cpa-panel-brand-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--cpa-primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
        </div>
        <span class="cpa-panel-brand-name">Chatplay
            <span class="cpa-panel-brand-version">v8</span>
        </span>
    `;

    const headerActions = document.createElement("div");
    headerActions.className = "cpa-panel-actions";

    function mkIconBtn(svg, title, onClick) {
        const b = document.createElement("button");
        b.className = "cpa-icon-btn";
        b.title = title;
        b.innerHTML = svg;
        b.onclick = onClick;
        return b;
    }

    const btnSug = mkIconBtn(
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
        "Gerar Sugestões (ALT+2)",
        async () => { await gerarSugestoesPainel(); }
    );
    const btnCfg = mkIconBtn(
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
        "Painel Profissional",
        () => criarPainelProfissional()
    );
    const btnMin = mkIconBtn(
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        "Minimizar",
        () => { painel.remove(); criarBotaoPrincipal(); }
    );

    headerActions.appendChild(btnSug);
    headerActions.appendChild(btnCfg);
    headerActions.appendChild(btnMin);
    header.appendChild(brand);
    header.appendChild(headerActions);
    painel.appendChild(header);

    /* MENSAGENS */
    const chatContainer = document.createElement("div");
    chatContainer.id = "chat-messages-container";
    chatContainer.className = "cpa-messages cpa-scroll";
    painel.appendChild(chatContainer);

    /* INPUT AREA */
    const inputArea = document.createElement("div");
    inputArea.className = "cpa-input-area";

    const inputRow = document.createElement("div");
    inputRow.className = "cpa-input-row";

    const textarea = document.createElement("textarea");
    textarea.className = "cpa-textarea";
    textarea.placeholder = "Mensagem... (Enter para enviar, Shift+Enter quebra linha)";
    textarea.rows = 1;

    textarea.oninput = function() {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 100) + "px";
    };
    textarea.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const val = textarea.value.trim();
            if (val) { enviarMensagemChat(val); textarea.value = ""; textarea.style.height = "auto"; }
        }
    };

    const btnSend = document.createElement("button");
    btnSend.className = "cpa-btn cpa-btn--primary";
    btnSend.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    btnSend.style.height = "36px";
    btnSend.style.padding = "0 12px";
    btnSend.title = "Enviar mensagem";
    btnSend.onclick = () => {
        const val = textarea.value.trim();
        if (val) { enviarMensagemChat(val); textarea.value = ""; textarea.style.height = "auto"; }
    };

    inputRow.appendChild(textarea);
    inputRow.appendChild(btnSend);

    const actionsRow = document.createElement("div");
    actionsRow.className = "cpa-btn-row";

    const btnSuggest = document.createElement("button");
    btnSuggest.className = "cpa-btn cpa-btn--accent";
    btnSuggest.style.flex = "1";
    btnSuggest.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Gerar Sugestões`;
    btnSuggest.onclick = async () => { await gerarSugestoesPainel(); };

    const btnClear = document.createElement("button");
    btnClear.className = "cpa-btn cpa-btn--ghost";
    btnClear.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Limpar`;
    btnClear.onclick = () => {
        if (confirm("Limpar todo o histórico do chat?")) {
            AppState.chatMessages = [];
            storageSet(STORAGE_KEYS.CHAT_MSGS, []);
            renderizarTodasMensagens();
        }
    };

    actionsRow.appendChild(btnSuggest);
    actionsRow.appendChild(btnClear);
    inputArea.appendChild(inputRow);
    inputArea.appendChild(actionsRow);
    painel.appendChild(inputArea);

    /* DRAG */
    let isDragging = false, ox, oy;
    header.onmousedown = (e) => {
        if (e.target.closest(".cpa-icon-btn")) return;
        isDragging = true; ox = e.clientX - painel.offsetLeft; oy = e.clientY - painel.offsetTop;
    };
    let rafId = null;
    document.addEventListener("mousemove", (e) => {
        if (!isDragging || rafId) return;
        rafId = requestAnimationFrame(() => {
            painel.style.left = (e.clientX - ox) + "px";
            painel.style.top  = (e.clientY - oy) + "px";
            painel.style.right = "auto";
            rafId = null;
        });
    });
    document.addEventListener("mouseup", () => { isDragging = false; });

    document.body.appendChild(painel);
    renderizarTodasMensagens();
}

function mostrarOpcoesLimpeza() { return; }


function criarPainelProfissional() {
    document.getElementById("ai-painel-profissional")?.remove();
    document.getElementById("cpa-prof-backdrop")?.remove();

    const backdrop = document.createElement("div");
    backdrop.id = "cpa-prof-backdrop";
    backdrop.className = "cpa-modal-backdrop cpa-root";
    backdrop.onclick = () => { backdrop.remove(); painel.remove(); };

    const painel = document.createElement("div");
    painel.id = "ai-painel-profissional";
    painel.className = "cpa-root";

    /* HEADER */
    const header = document.createElement("div");
    header.className = "cpa-modal-header";
    header.innerHTML = `
        <div class="cpa-modal-title">
            <div class="cpa-modal-title-dot"></div>
            Chatplay Assistant
            <span style="font-size:var(--cpa-text-xs);color:var(--cpa-text-3);font-weight:400;margin-left:4px">v8.0.0</span>
        </div>
    `;
    const btnClose = document.createElement("button");
    btnClose.className = "cpa-icon-btn";
    btnClose.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    btnClose.onclick = () => { backdrop.remove(); painel.remove(); };
    header.appendChild(btnClose);
    painel.appendChild(header);

    /* TABS */
    const tabBar = document.createElement("div");
    tabBar.className = "cpa-tabs";

    const tabActive = { current: "historico" };
    const tabDefs = [
        ["Histórico", "historico"],
        ["Respostas", "respostas"],
        ["Desaprovadas", "desaprovadas"],
        ["Configurações", "config"],
        ["Estatísticas", "stats"]
    ];

    function switchTab(id) {
        tabActive.current = id;
        document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");
        const el = document.getElementById(`tab-${id}`);
        if (el) el.style.display = "block";
        tabBar.querySelectorAll(".cpa-tab").forEach(t => {
            t.classList.toggle("cpa-tab--active", t.dataset.tab === id);
        });
    }

    tabDefs.forEach(([label, id]) => {
        const t = document.createElement("button");
        t.className = "cpa-tab" + (id === "historico" ? " cpa-tab--active" : "");
        t.dataset.tab = id;
        t.textContent = label;
        t.onclick = () => switchTab(id);
        tabBar.appendChild(t);
    });
    painel.appendChild(tabBar);

    /* CONTEÚDO */
    const content = document.createElement("div");
    content.className = "cpa-tab-content cpa-scroll";

    /* ── ABA: HISTÓRICO ── */
    const tabHistorico = document.createElement("div");
    tabHistorico.id = "tab-historico";
    tabHistorico.className = "tab-content";
    tabHistorico.style.display = "block";

    const statsGridH = document.createElement("div");
    statsGridH.className = "cpa-stats-grid cpa-stats-grid--4";

    const totalLog = Object.values(AppState.logSugestoes).reduce((a,b) => a+b.length, 0);
    [
        ["Sugestões Usadas",  AppState.estatisticas.totalSugestoes, "primary"],
        ["Economia API",      AppState.estatisticas.totalEconomiaAPI, "success"],
        ["Desaprovadas",      AppState.estatisticas.totalDesaprovadas, "danger"],
        ["Log Total",         totalLog, "accent"]
    ].forEach(([label, val, cls]) => {
        const c = document.createElement("div");
        c.className = "cpa-stat-card";
        c.innerHTML = `<div class="cpa-stat-label">${label}</div><div class="cpa-stat-val cpa-stat-val--${cls}">${val}</div>`;
        statsGridH.appendChild(c);
    });
    tabHistorico.appendChild(statsGridH);

    const searchH = document.createElement("input");
    searchH.className = "cpa-search";
    searchH.type = "text";
    searchH.placeholder = "Buscar no histórico…";
    tabHistorico.appendChild(searchH);

    const listaH = document.createElement("div");
    listaH.className = "cpa-history-list";
    tabHistorico.appendChild(listaH);

    let buscarTimeout;
    searchH.oninput = (e) => {
        clearTimeout(buscarTimeout);
        buscarTimeout = setTimeout(() => filtrarHistorico(e.target.value.toLowerCase()), 280);
    };

    function filtrarHistorico(termo = "") {
        listaH.innerHTML = "";
        const items = AppState.historico
            .filter(item => !termo || normalizar(item.pergunta).includes(termo))
            .slice(-50).reverse();

        if (items.length === 0) {
            listaH.innerHTML = `<div class="cpa-empty"><div class="cpa-empty-icon">📋</div><div class="cpa-empty-text">Nenhum item no histórico.</div></div>`;
            return;
        }

        items.forEach(item => {
            const card = document.createElement("div");
            card.id = `historico-item-${item.id}`;
            card.className = "cpa-history-card";
            card.style.borderLeftColor = getCorCategoria(item.categoria);

            const delBtn = document.createElement("button");
            delBtn.className = "cpa-delete-btn";
            delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>`;
            delBtn.title = "Excluir item";
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm("Excluir este item do histórico?")) excluirItemHistorico(item.id);
            };

            const cardHeader = document.createElement("div");
            cardHeader.className = "cpa-history-card-header";

            const badge = document.createElement("span");
            badge.className = "cpa-badge";
            badge.style.background = getCorCategoria(item.categoria, true);
            badge.style.color = getCorCategoria(item.categoria);
            badge.textContent = item.categoria;

            const dateEl = document.createElement("span");
            dateEl.className = "cpa-date";
            dateEl.textContent = new Date(item.data).toLocaleString("pt-BR");

            cardHeader.appendChild(badge);
            cardHeader.appendChild(dateEl);

            const qEl = document.createElement("div");
            qEl.className = "cpa-history-question";
            qEl.textContent = item.pergunta;

            const resps = document.createElement("div");
            resps.className = "cpa-history-responses";
            item.respostas.forEach(r => {
                const rb = document.createElement("button");
                rb.className = "cpa-history-resp-btn";
                rb.textContent = r;
                rb.onclick = () => { inserirNoCampoChatPlay(r); atualizarScoreResposta(r, item.categoria, true); };
                resps.appendChild(rb);
            });

            card.appendChild(delBtn);
            card.appendChild(cardHeader);
            card.appendChild(qEl);
            card.appendChild(resps);
            listaH.appendChild(card);
        });
    }

    content.appendChild(tabHistorico);

    /* ── ABA: RESPOSTAS ── */
    const tabRespostas = document.createElement("div");
    tabRespostas.id = "tab-respostas";
    tabRespostas.className = "tab-content";
    tabRespostas.style.display = "none";

    if (Object.keys(AppState.logSugestoes).length === 0) {
        tabRespostas.innerHTML = `<div class="cpa-empty"><div class="cpa-empty-icon">💬</div><div class="cpa-empty-text">Nenhuma sugestão escolhida ainda.</div><div class="cpa-empty-hint">As sugestões selecionadas aparecem aqui, separadas por categoria.</div></div>`;
    } else {
        Object.keys(AppState.logSugestoes).sort().forEach(cat => {
            const registros = AppState.logSugestoes[cat];
            if (!registros || registros.length === 0) return;

            const catBlock = document.createElement("div");
            catBlock.className = "cpa-cat-block";

            const catTitle = document.createElement("div");
            catTitle.className = "cpa-cat-title";
            catTitle.style.color = getCorCategoria(cat);

            const desapCat = AppState.sugestoesDesaprovadas.categorias[cat] || 0;
            catTitle.innerHTML = `
                <span>${cat}</span>
                <div class="cpa-cat-counters">
                    <span class="cpa-cat-counter" style="color:var(--cpa-success)">✓ ${registros.length} usadas</span>
                    <span class="cpa-cat-counter" style="color:var(--cpa-danger)">✕ ${desapCat} desap.</span>
                </div>
            `;

            [...registros].reverse().slice(0, 20).forEach(reg => {
                const item = document.createElement("div");
                item.className = "cpa-log-item";

                const meta = document.createElement("div");
                meta.className = "cpa-log-meta";
                meta.textContent = new Date(reg.data).toLocaleString("pt-BR");

                item.appendChild(meta);

                if (reg.pergunta) {
                    const quote = document.createElement("div");
                    quote.className = "cpa-log-quote";
                    quote.textContent = `"${reg.pergunta.substring(0, 90)}${reg.pergunta.length > 90 ? "…" : ""}"`;
                    item.appendChild(quote);
                }

                const btn = document.createElement("button");
                btn.className = "cpa-history-resp-btn";
                btn.textContent = reg.texto;
                btn.onclick = () => { inserirNoCampoChatPlay(reg.texto); atualizarScoreResposta(reg.texto, cat, true); };
                item.appendChild(btn);

                catBlock.appendChild(catTitle);
                catBlock.appendChild(item);
            });

            tabRespostas.appendChild(catBlock);
        });
    }
    content.appendChild(tabRespostas);

    /* ── ABA: DESAPROVADAS ── */
    const tabDesap = document.createElement("div");
    tabDesap.id = "tab-desaprovadas";
    tabDesap.className = "tab-content";
    tabDesap.style.display = "none";

    const statsGridD = document.createElement("div");
    statsGridD.className = "cpa-stats-grid cpa-stats-grid--3";
    [
        ["Total Desaprovadas", AppState.estatisticas.totalDesaprovadas, "danger"],
        ["Padrões ID",         AppState.sugestoesDesaprovadas.padroes.length, "warning"],
        ["Categorias Afetadas",Object.keys(AppState.sugestoesDesaprovadas.categorias).length, "primary"]
    ].forEach(([label, val, cls]) => {
        const c = document.createElement("div");
        c.className = "cpa-stat-card";
        c.innerHTML = `<div class="cpa-stat-label">${label}</div><div class="cpa-stat-val cpa-stat-val--${cls}">${val}</div>`;
        statsGridD.appendChild(c);
    });
    tabDesap.appendChild(statsGridD);

    if (AppState.sugestoesDesaprovadas.padroes.length > 0) {
        const secPad = document.createElement("div");
        secPad.className = "cpa-section";
        secPad.innerHTML = `<div class="cpa-section-title">Padrões identificados</div>`;
        const patWrap = document.createElement("div");
        patWrap.className = "cpa-pattern-wrap";
        AppState.sugestoesDesaprovadas.padroes.slice(0, 20).forEach(p => {
            const b = document.createElement("span");
            b.className = "cpa-pattern-badge";
            b.textContent = `${p.palavra} ×${p.contagem}`;
            patWrap.appendChild(b);
        });
        secPad.appendChild(patWrap);
        tabDesap.appendChild(secPad);
    }

    const secDesap = document.createElement("div");
    secDesap.className = "cpa-section";
    secDesap.innerHTML = `<div class="cpa-section-title">Últimas desaprovadas</div>`;

    if (AppState.sugestoesDesaprovadas.respostas.length === 0) {
        secDesap.innerHTML += `<div class="cpa-empty" style="padding:var(--cpa-sp-5)"><div class="cpa-empty-text">Nenhuma resposta desaprovada ainda.</div></div>`;
    } else {
        AppState.sugestoesDesaprovadas.respostas.slice(-20).reverse().forEach(item => {
            const card = document.createElement("div");
            card.className = "cpa-discard-card";

            const dh = document.createElement("div");
            dh.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--cpa-sp-2);padding-right:28px";
            const dBadge = document.createElement("span");
            dBadge.className = "cpa-badge";
            dBadge.style.background = getCorCategoria(item.categoria, true);
            dBadge.style.color = getCorCategoria(item.categoria);
            dBadge.textContent = item.categoria;
            const dDate = document.createElement("span");
            dDate.className = "cpa-date";
            dDate.textContent = new Date(item.data).toLocaleString("pt-BR");
            dh.appendChild(dBadge); dh.appendChild(dDate);

            const dq = document.createElement("div");
            dq.className = "cpa-log-quote";
            dq.textContent = `"${item.pergunta.substring(0, 80)}${item.pergunta.length > 80 ? "…" : ""}"`;

            const dr = document.createElement("div");
            dr.style.cssText = "font-size:var(--cpa-text-sm);color:var(--cpa-text-1);padding:var(--cpa-sp-2) var(--cpa-sp-3);background:var(--cpa-bg-1);border-radius:var(--cpa-r-md)";
            dr.textContent = item.resposta;

            card.appendChild(dh); card.appendChild(dq); card.appendChild(dr);
            secDesap.appendChild(card);
        });
    }
    tabDesap.appendChild(secDesap);
    content.appendChild(tabDesap);

    /* ── ABA: CONFIG ── */
    const tabConfig = document.createElement("div");
    tabConfig.id = "tab-config";
    tabConfig.className = "tab-content";
    tabConfig.style.display = "none";

    // Seção de status da conexão com o servidor
    const secApi = document.createElement("div");
    secApi.className = "cpa-section";
    secApi.innerHTML = `<div class="cpa-section-title">Servidor</div>`;
    const apiStatus = document.createElement("div");
    apiStatus.style.cssText = "margin-top:var(--cpa-sp-2);font-size:var(--cpa-text-xs)";
    apiStatus.style.color = CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN
        ? "var(--cpa-success)"
        : "var(--cpa-warning)";
    apiStatus.textContent = CONFIG.BACKEND_URL && CONFIG.BACKEND_TOKEN
        ? "✓ Conectado ao servidor"
        : "⚠ Faça login no popup da extensão";
    secApi.appendChild(apiStatus);

    const secPref = document.createElement("div");
    secPref.className = "cpa-section";
    secPref.innerHTML = `<div class="cpa-section-title">Preferências</div>`;

    const prefs = [
        ["Notificações", "notificacoes"],
    ];

    prefs.forEach(([label, key]) => {
        const row = document.createElement("div");
        row.className = "cpa-pref-row";
        const lbl = document.createElement("label");
        lbl.className = "cpa-pref-label";
        lbl.textContent = label;
        lbl.htmlFor = `cpa-pref-${key}`;
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "cpa-toggle";
        toggle.id = `cpa-pref-${key}`;
        toggle.checked = !!AppState.preferencias[key];
        row.appendChild(lbl); row.appendChild(toggle);
        secPref.appendChild(row);
    });

    const btnSaveConfig = document.createElement("button");
    btnSaveConfig.className = "cpa-btn cpa-btn--primary cpa-btn--full";
    btnSaveConfig.textContent = "Salvar configurações";
    btnSaveConfig.onclick = () => {
        prefs.forEach(([, key]) => {
            AppState.preferencias[key] = !!document.getElementById(`cpa-pref-${key}`)?.checked;
        });
        storageSet("preferencias_v7", AppState.preferencias);
        mostrarNotificacao("Configurações salvas.", "sucesso");
    };

    tabConfig.appendChild(secApi);
    tabConfig.appendChild(secPref);
    tabConfig.appendChild(btnSaveConfig);
    content.appendChild(tabConfig);

    /* ── ABA: STATS ── */
    const tabStats = document.createElement("div");
    tabStats.id = "tab-stats";
    tabStats.className = "tab-content";
    tabStats.style.display = "none";

    const tmedio = AppState.estatisticas.performance?.tempoMedioResposta || 0;
    const tchamadas = AppState.estatisticas.performance?.chamadasAPI || 0;
    const totalTemplates = Object.values(AppState.templates).reduce((a,b) => a+b.length, 0);
    const totalLogEntradas = Object.values(AppState.logSugestoes).reduce((a,b) => a+b.length, 0);

    const statsGridS = document.createElement("div");
    statsGridS.className = "cpa-stats-grid cpa-stats-grid--2";
    [
        ["Sugestões usadas",    AppState.estatisticas.totalSugestoes, "primary"],
        ["Templates aprendidos",totalTemplates, "accent"],
        ["Tempo médio API",     tmedio.toFixed(0)+"ms", "warning"],
        ["Chamadas API",        tchamadas, "danger"],
        ["Economia API",        AppState.estatisticas.totalEconomiaAPI, "success"],
        ["Total no log",        totalLogEntradas, "primary"]
    ].forEach(([label, val, cls]) => {
        const c = document.createElement("div");
        c.className = "cpa-stat-card";
        c.innerHTML = `<div class="cpa-stat-label">${label}</div><div class="cpa-stat-val cpa-stat-val--${cls}">${val}</div>`;
        statsGridS.appendChild(c);
    });

    const secCats = document.createElement("div");
    secCats.className = "cpa-section";
    secCats.innerHTML = `<div class="cpa-section-title">Categorias mais usadas</div>`;
    const catList = Object.entries(AppState.estatisticas.categoriasMaisUsadas || {}).sort((a,b) => b[1]-a[1]).slice(0, 8);
    if (catList.length === 0) {
        secCats.innerHTML += `<div style="font-size:var(--cpa-text-sm);color:var(--cpa-text-3)">Nenhuma categoria registrada ainda.</div>`;
    } else {
        catList.forEach(([cat, count]) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:var(--cpa-sp-1) 0;border-bottom:1px solid var(--cpa-border)";
            const maxCount = catList[0][1];
            const pct = Math.round((count/maxCount)*100);
            row.innerHTML = `
                <span style="font-size:var(--cpa-text-sm);color:${getCorCategoria(cat)}">${cat}</span>
                <div style="display:flex;align-items:center;gap:var(--cpa-sp-3)">
                    <div style="width:80px;height:4px;background:var(--cpa-border);border-radius:var(--cpa-r-full)">
                        <div style="width:${pct}%;height:100%;background:${getCorCategoria(cat)};border-radius:var(--cpa-r-full)"></div>
                    </div>
                    <span style="font-size:var(--cpa-text-sm);font-weight:600;color:var(--cpa-text-1);min-width:20px;text-align:right">${count}</span>
                </div>
            `;
            secCats.appendChild(row);
        });
    }

    const secLearn = document.createElement("div");
    secLearn.className = "cpa-section";
    secLearn.innerHTML = `
        <div class="cpa-section-title">Aprendizado</div>
        <div style="display:flex;justify-content:space-between;font-size:var(--cpa-text-sm);padding:var(--cpa-sp-1) 0;border-bottom:1px solid var(--cpa-border)">
            <span style="color:var(--cpa-text-2)">Respostas com score</span>
            <span style="color:var(--cpa-text-1);font-weight:600">${Object.keys(AppState.scoresRespostas).length}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:var(--cpa-text-sm);padding:var(--cpa-sp-1) 0">
            <span style="color:var(--cpa-text-2)">Taxa de acerto média</span>
            <span style="color:var(--cpa-success);font-weight:600">${calcularTaxaAcertoMedia().toFixed(1)}%</span>
        </div>
    `;

    tabStats.appendChild(statsGridS);
    tabStats.appendChild(secCats);
    tabStats.appendChild(secLearn);
    content.appendChild(tabStats);

    painel.appendChild(content);

    document.body.appendChild(backdrop);
    document.body.appendChild(painel);

    filtrarHistorico();
}


/** @namespace UI — ponto de acesso público do módulo */
const UI = {
    adicionarAnimacoesCSS,
    getCorCategoria,
    renderizarMensagemNoChat,
    renderizarTodasMensagens,
    mostrarDigitacao,
    removerDigitacao,
    mostrarNotificacao,
    criarBotaoAcao,
    criarBotaoPrincipal,
    criarPainelFixo,
    criarPainelProfissional,
};

/* ══════════════════════════════════════════════════════════════
   [M0] Bootstrap — Atalhos e Inicialização
   Ponto de entrada único. Na extensão: content_script onload
══════════════════════════════════════════════════════════════ */

function configurarAtalhos() {
    document.addEventListener("keydown", (e) => {
        if (e.altKey && e.key === "1") {
            e.preventDefault();
            const p = document.getElementById("ai-painel-fixo");
            if (p) { p.remove(); criarBotaoPrincipal(); }
            else { document.getElementById("ai-botao-principal")?.remove(); criarPainelFixo(); }
        }
        if (e.altKey && e.key === "2") { e.preventDefault(); gerarSugestoesPainel(); }
        if (e.altKey && e.key === "3") {
            e.preventDefault();
            document.getElementById("ai-painel-profissional")?.remove();
            document.getElementById("cpa-prof-backdrop")?.remove();
        }
    });
}

/**
 * inicializar — Bootstrap principal async.
 *
 * Fluxo:
 *   1. carregarAppState() — lê todo o storage (batch, await-safe)
 *   2. _inicializarOnChanged() — ativa listener multi-aba se chrome env
 *   3. Monta UI — com AppState já populado (sem dados vazios na tela)
 *   4. Notificação de chave se necessário
 *
 * Em Fase A (GM_*): carregarAppState resolve síncronamente via Promise.resolve.
 * Em Fase B (chrome.storage): await carregarAppState() suspende até storage pronto.
 */
async function inicializar() {
    console.log("[Chatplay Assistant] 🚀 v9.2.0 inicializando (backend-first)...");
    console.log(`[Chatplay Assistant] 🔌 StorageAdapter ativo: "${STORAGE_ENV}"`);

    // ── Fase 1: carregar estado persistido (await-safe para Fase B)
    try {
        await carregarAppState();
    } catch (err) {
        console.error("[Chatplay Assistant] ⚠️ Erro ao carregar AppState:", err);
        // Garante estrutura mínima mesmo em caso de falha
        AppState.estatisticas = garantirEstruturaEstatisticas(null);
    }

    // ── Fase 2: ativar listener multi-aba (no-op se ENV !== "chrome")
    _inicializarOnChanged();

    // ── Fase 3: montar interface (AppState já populado)
    adicionarAnimacoesCSS();
    configurarAtalhos();
    criarBotaoPrincipal();

    // ── Fase 4: validar sessão com backend e carregar settings da org
    // Carregar settings: garantir que carregarAppState terminou antes de sincronizar
    // carregarAppState já foi awaited acima, então podemos sincronizar com delay mínimo
    // para o DOM estar pronto
    setTimeout(() => {
        // Re-checar token após DOM montado (garante que storage foi lido)
        if (CONFIG.BACKEND_TOKEN) {
            _sincronizarSettingsBackend();
        }
    }, 800);

    console.log("[Chatplay Assistant] ✅ Pronto. AppState populado antes da UI.");
}

// Bootstrap gerenciado pelo content_script.js (MutationObserver)
// O content_script chama inicializar() após o DOM estar pronto.


// ── API pública para relay de autenticação pelo content_script ──
/**
 * setAuthToken — atualiza o token de autenticação em memória e no storage.
 * Chamado pelo content_script quando popup faz login/logout sem reload de página.
 *
 * @param {string|null} token — null para limpar (logout)
 */
function setAuthToken(token) {
    if (token) {
        CONFIG.BACKEND_TOKEN = token;
        storageSet(STORAGE_KEYS.BACKEND_TOKEN, token);
        console.log('[Chatplay Core] 🔑 Token atualizado via relay.');
        // Sincronizar settings do backend após login
        _sincronizarSettingsBackend();
    } else {
        CONFIG.BACKEND_TOKEN = '';
        storageDel(STORAGE_KEYS.BACKEND_TOKEN);
        console.log('[Chatplay Core] 🔒 Token removido (logout).');
    }
}

/**
 * _sincronizarSettingsBackend — busca settings da org no backend e atualiza
 * CONFIG e AppState. Chamada no boot (se token presente) e após login.
 */
async function _sincronizarSettingsBackend() {
    // Se não há token, apenas logar silenciosamente — sem notificação intrusiva no boot
    if (!CONFIG.BACKEND_URL || !CONFIG.BACKEND_TOKEN) {
        console.log('[Chatplay Core] ℹ️ Token ausente — aguardando login do usuário.');
        return;
    }
    try {
        const me = await BackendAPI.request('/api/auth/me');
        if (me?.user) {
            console.log('[Chatplay Core] 👤 Sessão válida:', me.user.email, '| Org:', me.user.organizationId);
        }

        const settings = await BackendAPI.getSettings();
        if (settings?.settings) {
            const s = settings.settings;

            // ── Aprendizado / qualidade ──────────────────────────────────
            if (s['suggestion.autoSuggest']         !== undefined)
                AppState.preferencias.autoSugestao = Boolean(s['suggestion.autoSuggest']);
            if (s['suggestion.filterRejected']       !== undefined)
                AppState.preferencias.evitarDesaprovadas = Boolean(s['suggestion.filterRejected']);
            if (s['suggestion.learnFromApproved']    !== undefined)
                AppState.preferencias.usarTemplates = Boolean(s['suggestion.learnFromApproved']);
            // legado (compatibilidade com keys antigos)
            if (s['learning.avoid_rejected']         !== undefined)
                AppState.preferencias.evitarDesaprovadas = Boolean(s['learning.avoid_rejected']);
            if (s['learning.use_templates']          !== undefined)
                AppState.preferencias.usarTemplates = Boolean(s['learning.use_templates']);

            // ── Modelo de IA ──────────────────────────────────────────────
            if (s['suggestion.model'])               CONFIG.MODEL_IA = s['suggestion.model'];
            if (s['ai.model'])                       CONFIG.MODEL_IA = s['ai.model'];

            // ── Limites por usuário (aplicados no core) ───────────────────
            if (s['limits.suggestionsPerUserPerDay'] !== undefined)
                CONFIG.LIMIT_SUGGESTIONS_PER_DAY = Number(s['limits.suggestionsPerUserPerDay']);
            if (s['limits.chatMessagesPerUserPerDay'] !== undefined)
                CONFIG.LIMIT_CHAT_PER_DAY = Number(s['limits.chatMessagesPerUserPerDay']);

            console.log('[Chatplay Core] ⚙️ Settings da org sincronizados:', Object.keys(s).length, 'chave(s)');
        }
    } catch (err) {
        const status = err.message || '';
        const errStatus = err.status || 0;
        if (errStatus === 401 || errStatus === 403 ||
            status.includes('401') || status.includes('403') || status.includes('Sessão')) {
            CONFIG.BACKEND_TOKEN = '';
            storageDel(STORAGE_KEYS.BACKEND_TOKEN);
            mostrarNotificacao('Sessão expirada. Faça login novamente no popup da extensão.', 'aviso');
        } else if (errStatus === 503 || status.includes('503') || status.includes('indisponível')) {
            // Banco offline temporariamente — não é erro de sessão
            console.warn('[Chatplay Core] ⚠️ Backend com banco offline — modo degradado ativo.');
        } else {
            // Backend inacessível (rede, timeout, etc.)
            console.warn('[Chatplay Core] Backend inacessível — operando com dados locais.');
        }
    }
}

/**
 * setBackendUrl — atualiza a URL do backend em memória e no storage.
 * Chamado pelo content_script quando popup salva nova URL.
 *
 * @param {string} url
 */
function setBackendUrl(url) {
    CONFIG.BACKEND_URL = url;
    storageSet('chatplay_backend_url', url);
    console.log('[Chatplay Core] ⚙️ BACKEND_URL atualizado:', url);
}

export { inicializar, setAuthToken, setBackendUrl };
