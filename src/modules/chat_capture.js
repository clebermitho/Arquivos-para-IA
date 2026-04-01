/**
 * chat_capture.js — M3 (leitura): Localização de mensagens no DOM do Chatplay.
 *
 * Funções de captura e análise de mensagens — apenas leitura do DOM.
 * A inserção de texto no campo de chat (inserirNoCampoChatPlay) permanece
 * em chatplay_core.js pois depende de notificações de UI.
 *
 * Migração futura: mover para content_script como observer dedicado.
 */
'use strict';

import { CONFIG } from './config.js';
import { normalizar } from './text_analysis.js';

/**
 * Captura as últimas mensagens visíveis no painel do Chatplay.
 * @param {number} qtd – quantidade máxima de mensagens a capturar
 */
export function capturarMensagens(qtd = CONFIG.MAX_MESSAGES_TO_CAPTURE) {
    let msgs = [...document.querySelectorAll("span[class*='foreground']")];
    if (msgs.length === 0) return [];

    let lista = msgs.slice(-qtd).map(m => ({
        autor: descobrirAutor(m),
        texto: m.textContent ? m.textContent.trim() : m.innerText.trim(),
        timestamp: Date.now(),
    }));

    console.log(`[Chatplay Assistant] 📨 Mensagens capturadas: ${lista.length}`);
    return lista;
}

/**
 * Identifica o autor de uma mensagem percorrendo a árvore DOM.
 */
export function descobrirAutor(el) {
    let node = el;
    while (node) {
        if (node.className && node.className.includes("bg-secondary")) return "CLIENTE";
        if (node.className && node.className.includes("self-end"))     return "OPERADOR";
        node = node.parentElement;
    }
    return "OPERADOR";
}

/**
 * Detecta a última pergunta relevante enviada pelo cliente.
 * Ignora mensagens muito curtas ou respostas simples de confirmação.
 */
export function detectarPergunta(mensagens) {
    const ignorar = ["ok", "sim", "obrigado", "valeu", "👍", "...", "entendi", "certo"];
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
