/**
 * text_analysis.js — M2: Normalização, tokenização e classificação de intenção.
 *
 * Funções puramente textuais sem dependência de UI ou storage.
 * Migração futura: isolar como Web Worker ou microserviço de NLP.
 */
'use strict';

import { AppState } from './state.js';

export function normalizar(txt) {
    if (!txt) return "";
    return txt
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function tokenizar(texto, pesos = false) {
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

export function extrairPalavrasChave(texto, limite = 5) {
    let pesos = tokenizar(texto, true);
    return Object.entries(pesos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limite)
        .map(([palavra]) => palavra);
}

export function calcularSimilaridadeSemantica(a, b) {
    let pesosA  = tokenizar(a, true);       // {token: peso}
    let tokensA = Object.keys(pesosA);      // reutiliza tokenização com pesos
    let tokensB = tokenizar(b);

    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const stopwords = ["para", "como", "com", "uma", "pelos", "sobre", "entre", "após", "durante", "mediante", "mas", "pois", "portanto"];

    let score = 0;
    let pesoTotal = 0;

    tokensA.forEach(token => {
        let pesoToken = pesosA[token] || 1;
        if (stopwords.includes(token)) pesoToken *= 0.3;

        if (tokensB.includes(token)) {
            let bonus = token.length > 6 ? 1.5 : 1;
            score += pesoToken * bonus;
        }
        pesoTotal += pesoToken;
    });

    let normalizado = pesoTotal > 0 ? score / pesoTotal : 0;

    let categoriaA = classificarIntencao(a);
    let categoriaB = classificarIntencao(b);
    if (categoriaA === categoriaB) normalizado += 0.2;

    return Math.min(normalizado, 1);
}

export function classificarIntencao(texto) {
    let t = normalizar(texto);

    const categorias = {
        SUSPENSAO: {
            palavras: ["suspens", "suspende", "paralisar", "interromper", "pausar", "baixa temporária"],
            peso: 1.5,
        },
        CANCELAMENTO: {
            palavras: ["cancel", "cancela", "encerrar", "terminar", "desistir", "anular", "excluir"],
            peso: 1.5,
        },
        NADA_CONSTA: {
            palavras: ["nada consta", "não consta", "sem registro", "não encontrado", "inexistente"],
            peso: 2.0,
        },
        GOLPE: {
            palavras: ["golpe", "fraude", "enganaram", "problema", "suspeito", "estelionato"],
            peso: 2.0,
        },
        PRAZO: {
            palavras: ["prazo", "tempo", "demora", "quanto tempo", "previsão", "quando", "data limite"],
            peso: 1.2,
        },
        NEGOCIACAO: {
            palavras: ["parcel", "negoci", "acordo", "divid", "débito", "dev", "anuidade", "regularizar", "pagamento"],
            peso: 1.3,
        },
        SEM_DINHEIRO: {
            palavras: ["dinheiro", "pagar", "sem condi", "caro", "valor alto", "difícil", "apertado"],
            peso: 1.3,
        },
        DUVIDA: {
            palavras: ["dúvida", "dúvidas", "esclarec", "entender", "como funciona", "explicar", "significa"],
            peso: 1.0,
        },
        RECLAMACAO: {
            palavras: ["reclam", "problema", "erro", "não funciona", "ruim", "péssimo", "insatisfeito"],
            peso: 1.2,
        },
    };

    let scores = {};

    for (let [categoria, config] of Object.entries(categorias)) {
        let score = 0;
        for (let palavra of config.palavras) {
            if (t.includes(palavra)) score += config.peso;
        }
        if (score > 0) scores[categoria] = score;
    }

    if (t.includes("não") || t.includes("nunca") || t.includes("jamais")) {
        for (let cat in scores) scores[cat] *= 0.8;
    }

    if (Object.keys(scores).length > 0) {
        return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    }

    return "OUTROS";
}
