/**
 * learning_engine.js — M6: Feedback, scores de respostas e aprendizado de templates.
 *
 * Responsabilidades:
 *   - Registrar sugestões usadas no log por categoria
 *   - Aprender novos templates a partir de respostas aprovadas
 *   - Manter scores de acerto/erro por resposta
 *   - Registrar e consultar respostas desaprovadas
 *   - Filtrar sugestões com base em padrões desaprovados
 *
 * Migração futura: centralizar aprendizado no backend para compartilhar entre sessões.
 */
'use strict';

import { AppState } from './state.js';
import { storageUpdate } from './storage.js';
import { STORAGE_KEYS } from './config.js';
import { normalizar, extrairPalavrasChave, calcularSimilaridadeSemantica } from './text_analysis.js';

/**
 * Salva uma sugestão no log da categoria.
 * Idempotente: ignora duplicatas por suggestionId ou texto normalizado.
 */
export function salvarSugestaoNoLog(sugestao, pergunta, categoria, suggestionId = null) {
    if (!AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria] = [];
    }

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
        id: Date.now(),
    };

    AppState.logSugestoes[categoria].push(registro);

    if (AppState.logSugestoes[categoria].length > 500) {
        AppState.logSugestoes[categoria] = AppState.logSugestoes[categoria].slice(-500);
    }

    storageUpdate(STORAGE_KEYS.LOG_SUGESTOES, () => AppState.logSugestoes, {});

    AppState.estatisticas.totalSugestoes = (AppState.estatisticas.totalSugestoes || 0) + 1;
    if (!AppState.estatisticas.categoriasMaisUsadas) AppState.estatisticas.categoriasMaisUsadas = {};
    AppState.estatisticas.categoriasMaisUsadas[categoria] = (AppState.estatisticas.categoriasMaisUsadas[categoria] || 0) + 1;
    storageUpdate(STORAGE_KEYS.STATS, () => AppState.estatisticas, {});

    console.log(`[Chatplay Assistant] 📝 Sugestão salva no log | Categoria: ${categoria}`);
}

/**
 * Aprende um novo template a partir de uma resposta aprovada.
 * Ignora respostas semanticamente similares a templates existentes (> 0.9).
 */
export function aprenderComRespostasBoas(resposta, categoria) {
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
// Entradas expiradas (> 10 s) são removidas a cada 50 chamadas para evitar leak de memória.
const _feedbackLock = new Map();
let _feedbackLockCallCount = 0;

function _purgeFeedbackLock() {
    const cutoff = Date.now() - 10000; // 10 segundos
    for (const [key, ts] of _feedbackLock) {
        if (ts < cutoff) _feedbackLock.delete(key);
    }
}

/**
 * Atualiza o score de acerto/erro de uma resposta.
 * Debounce de 2 segundos para evitar feedback duplicado por duplo clique.
 */
export function atualizarScoreResposta(resposta, categoria, foiBoa) {
    const chave   = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
    const lockKey = `${chave}:${foiBoa ? 'ok' : 'rej'}`;

    const agora = Date.now();
    if (_feedbackLock.has(lockKey) && agora - _feedbackLock.get(lockKey) < 2000) {
        console.log("[Chatplay Assistant] ⚠️ Feedback duplicado ignorado (debounce 2s).");
        return;
    }
    _feedbackLock.set(lockKey, agora);

    // Limpar entradas expiradas a cada 50 chamadas
    if (++_feedbackLockCallCount % 50 === 0) _purgeFeedbackLock();

    if (!AppState.scoresRespostas[chave]) {
        AppState.scoresRespostas[chave] = { acertos: 0, erros: 0, ultimoUso: Date.now() };
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

    storageUpdate(STORAGE_KEYS.SCORES, () => AppState.scoresRespostas, {});
}

/**
 * Retorna as melhores respostas históricas para uma categoria,
 * ordenadas por taxa de acerto ponderada.
 */
export function getMelhoresRespostas(categoria, limite = 5) {
    let candidatas = [];

    if (AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria].forEach(registro => {
            let resposta = registro.texto;
            let chave    = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
            let score    = AppState.scoresRespostas[chave] || { acertos: 0, erros: 0 };
            let taxaAcerto = score.acertos / (score.acertos + score.erros + 0.1);
            candidatas.push({ resposta, score: taxaAcerto * (score.acertos + 1) });
        });
    }

    (AppState.templates[categoria] || []).forEach(resposta => {
        let chave  = `${categoria}:${normalizar(resposta).substring(0, 50)}`;
        let score  = AppState.scoresRespostas[chave] || { acertos: 0, erros: 0 };
        let taxaAcerto = score.acertos / (score.acertos + score.erros + 0.1);
        candidatas.push({ resposta, score: taxaAcerto * (score.acertos + 1) });
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

/**
 * Registra uma resposta como desaprovada e remove dos logs.
 * Idempotente: ignora duplicatas.
 * @returns {boolean} true se registrou, false se já existia
 */
export function registrarRespostaDesaprovada(resposta, pergunta, categoria, contexto, suggestionId = null) {
    console.log("[Chatplay Assistant] ❌ Registrando resposta desaprovada...");

    const normResp = normalizar(resposta);
    const jaSalva  = AppState.sugestoesDesaprovadas.respostas.some(r =>
        (suggestionId && r.suggestionId === suggestionId) ||
        normalizar(r.resposta) === normResp
    );
    if (jaSalva) {
        console.log("[Chatplay Assistant] ⚠️ Desaprovada já registrada — ignorando duplicata.");
        return false;
    }

    let palavrasChave = extrairPalavrasChave(resposta);

    let registro = {
        id:           Date.now(),
        suggestionId: suggestionId || null,
        resposta,
        pergunta,
        categoria,
        palavrasChave,
        contexto:     contexto ? contexto.substring(0, 300) : "",
        data:         new Date().toISOString(),
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
                palavra,
                contagem:    1,
                primeiraVez: Date.now(),
                ultimaVez:   Date.now(),
                categorias:  [categoria],
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

    storageUpdate(STORAGE_KEYS.DESAPROVADAS, () => AppState.sugestoesDesaprovadas, { respostas: [], categorias: {}, padroes: [] });

    AppState.estatisticas.totalDesaprovadas++;
    storageUpdate(STORAGE_KEYS.STATS, () => AppState.estatisticas, {});

    console.log(`[Chatplay Assistant] ✅ Resposta desaprovada registrada! Total: ${AppState.estatisticas.totalDesaprovadas}`);
    return true;
}

/** Remove uma resposta do histórico e do log de sugestões. */
export function removerRespostaDosLogs(resposta, categoria) {
    AppState.historico = AppState.historico.map(item => {
        if (item.respostas && Array.isArray(item.respostas)) {
            item.respostas = item.respostas.filter(r => normalizar(r) !== normalizar(resposta));
            if (item.respostas.length === 0) return null;
        }
        return item;
    }).filter(item => item !== null);

    if (AppState.logSugestoes[categoria]) {
        AppState.logSugestoes[categoria] = AppState.logSugestoes[categoria].filter(
            reg => normalizar(reg.texto) !== normalizar(resposta)
        );
        if (AppState.logSugestoes[categoria].length === 0) {
            delete AppState.logSugestoes[categoria];
        }
    }

    storageUpdate(STORAGE_KEYS.HISTORICO,     () => AppState.historico,    []);
    storageUpdate(STORAGE_KEYS.LOG_SUGESTOES, () => AppState.logSugestoes, {});
}

/** Verifica se uma resposta deve ser evitada com base no histórico de desaprovações. */
export function verificarRespostaDesaprovada(resposta) {
    if (!AppState.preferencias.evitarDesaprovadas) return false;

    let palavrasChave = extrairPalavrasChave(resposta);

    for (let desaprovada of AppState.sugestoesDesaprovadas.respostas) {
        if (calcularSimilaridadeSemantica(resposta, desaprovada.resposta) > 0.8) return true;
    }

    for (let padrao of AppState.sugestoesDesaprovadas.padroes) {
        if (palavrasChave.includes(padrao.palavra) && padrao.contagem > 3) return true;
    }

    return false;
}

/** Filtra respostas que devem ser evitadas por semelhança com desaprovadas. */
export function filtrarRespostasDesaprovadas(respostas) {
    if (!AppState.preferencias.evitarDesaprovadas || respostas.length === 0) return respostas;

    let respostasFiltradas = respostas.filter(r => !verificarRespostaDesaprovada(r));

    if (respostasFiltradas.length < respostas.length) {
        console.log(`[Chatplay Assistant] 🚫 ${respostas.length - respostasFiltradas.length} respostas removidas por serem desaprovadas`);
    }

    return respostasFiltradas;
}

/** Calcula a taxa de acerto média sobre todos os scores registrados. */
export function calcularTaxaAcertoMedia() {
    let total = 0;
    let soma  = 0;

    Object.values(AppState.scoresRespostas).forEach(score => {
        if (score.acertos + score.erros > 0) {
            soma += (score.acertos / (score.acertos + score.erros)) * 100;
            total++;
        }
    });

    return total > 0 ? soma / total : 0;
}
