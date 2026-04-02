/**
 * chatplay_core.js — Orquestrador principal da extensão AssistentePlay
 * @version 9.2.0
 *
 * Este arquivo importa os módulos puros de `src/modules/` e contém apenas os
 * componentes que dependem de UI (circular deps resolvidos por co-localização):
 *
 *   [M3-UI]  inserirNoCampoChatPlay — inserção DOM + notificação
 *   [M5]     SuggestionEngine — geração de sugestões (chama UI para feedback)
 *   [M7]     HistoryManager — histórico (chama UI para notificações)
 *   [M8]     ChatEngine — mensagens do chat interno (chama UI para renderização)
 *   [M9]     UI — design system, painéis, toasts, drag
 *   [M0]     Bootstrap — inicialização, atalhos, API pública
 *
 * Módulos puros (sem deps de UI) estão em src/modules/:
 *   config.js, state.js, storage.js, text_analysis.js,
 *   chat_capture.js, knowledge_base.js, backend_api.js, learning_engine.js
 */
'use strict';

// ── Importações de módulos puros ──────────────────────────────────────────
import { CONFIG, STORAGE_KEYS, STORAGE_ENV } from './modules/config.js';
import { AppState } from './modules/state.js';
import {
    storageSet, storageUpdate, storageDel,
    carregarAppState, garantirEstruturaEstatisticas, _inicializarOnChanged,
} from './modules/storage.js';
import {
    normalizar, tokenizar, classificarIntencao, classificarIntencaoComConfianca, calcularSimilaridadeSemantica,
} from './modules/text_analysis.js';
import { capturarMensagens, detectarPergunta } from './modules/chat_capture.js';
import { carregarConhecimentoCoren, carregarConhecimentoChat } from './modules/knowledge_base.js';
import { BackendAPI } from './modules/backend_api.js';
import {
    salvarSugestaoNoLog, registrarRespostaDesaprovada,
    atualizarScoreResposta, getMelhoresRespostas, calcularTaxaAcertoMedia,
} from './modules/learning_engine.js';

// ── Variáveis de controle de UI (não persistidas, locais a este módulo) ───
let isGenerating             = false;
let sugestaoSelecionadaAtual = null; // rastreia botão selecionado visualmente

/* ══════════════════════════════════════════════════════════════
   [M3-UI] inserirNoCampoChatPlay
   Inserção de texto no campo de mensagem do Chatplay via nativeSetter.
   Mantido aqui pois depende de mostrarNotificacao (M9).
══════════════════════════════════════════════════════════════ */

function inserirNoCampoChatPlay(texto) {
    let campo = document.querySelector("textarea[placeholder*='Digite sua mensagem']");
    if (!campo) campo = document.querySelector("textarea");
    if (!campo) campo = document.querySelector("input[type='text']");

    if (!campo) {
        console.warn("[Chatplay Assistant] ❌ Campo de chat não encontrado");
        mostrarNotificacao("❌ Campo de chat não encontrado", "erro");
        return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement?.prototype, "value"
    );
    if (!descriptor?.set) {
        // Fallback: atribuição direta (sem React synthetic events)
        campo.value = texto;
        campo.dispatchEvent(new Event('input',  { bubbles: true }));
        campo.dispatchEvent(new Event('change', { bubbles: true }));
        campo.focus();
        mostrarNotificacao("✅ Resposta inserida no chat!");
        return;
    }

    descriptor.set.call(campo, texto);
    campo.dispatchEvent(new Event('input',  { bubbles: true }));
    campo.dispatchEvent(new Event('change', { bubbles: true }));
    campo.focus();

    console.log(`[Chatplay Assistant] 📝 Mensagem inserida: "${texto.substring(0, 70)}..."`);
    mostrarNotificacao("✅ Resposta inserida no chat!");
}

/* ══════════════════════════════════════════════════════════════
   [M5] MODULE: SuggestionEngine
   Templates, montagem de contexto e chamada ao backend para sugestões.
══════════════════════════════════════════════════════════════ */

function getTemplatesParaCategoria(categoria) {
    if (!AppState.preferencias.usarTemplates) return [];
    let templates = AppState.templates[categoria] || [];
    if (templates.length === 0) templates = getTemplatesPadrao(categoria);
    return templates;
}

function getTemplatesPadrao(categoria) {
    const templatesPadrao = {
        NEGOCIACAO: [
            "Verifiquei que há anuidades em aberto. Podemos negociar o pagamento de forma parcelada para regularizar sua situação.",
            "Identificamos pendências financeiras. Há opções de parcelamento disponíveis para quitação.",
            "Para regularizar sua inscrição, é necessário acertar as anuidades em aberto. Posso auxiliar com isso?",
        ],
        SUSPENSAO: [
            "A suspensão temporária da inscrição é possível mediante solicitação formal e situação regular.",
            "Para interromper temporariamente o exercício profissional, é necessário protocolar requerimento de baixa temporária.",
            "A baixa temporária pode ser solicitada quando não houver exercício profissional por período determinado.",
        ],
        CANCELAMENTO: [
            "O cancelamento definitivo da inscrição requer protocolo formal e quitação de débitos existentes.",
            "Para cancelar sua inscrição, é necessário estar em dia com as obrigações e protocolar requerimento.",
            "O processo de cancelamento de inscrição deve ser formalizado junto ao protocolo geral.",
        ],
        DUVIDA: [
            "Esclareço que o procedimento correto é conforme orientação do setor responsável.",
            "Para informações detalhadas, recomendo contato direto com nosso setor de atendimento.",
            "Posso auxiliar com informações gerais, mas casos específicos devem ser verificados no sistema.",
        ],
        RECLAMACAO: [
            "Lamento pelo ocorrido. Vamos verificar a situação e dar o devido encaminhamento.",
            "Registrarei sua reclamação para análise do setor responsável.",
            "Sua manifestação será encaminhada para providências cabíveis.",
        ],
    };
    return templatesPadrao[categoria] || [];
}

async function gerarRespostasIA(contexto, pergunta) {
    if (isGenerating) {
        mostrarNotificacao("⏳ Já gerando respostas, aguarde...", "aviso");
        return null;
    }

    isGenerating = true;

    try {
        // Garantir que CONFIG tem os valores mais recentes do storage
        if (!CONFIG.BACKEND_TOKEN) {
            try {
                const _s = await chrome.storage.local.get(['backend_token_v1', 'chatplay_backend_url']);
                if (_s['backend_token_v1'])     CONFIG.BACKEND_TOKEN = _s['backend_token_v1'];
                if (_s['chatplay_backend_url']) CONFIG.BACKEND_URL   = _s['chatplay_backend_url'];
            } catch (_) { /* sem chrome.storage */ }
        }

        if (!CONFIG.BACKEND_URL || !CONFIG.BACKEND_TOKEN) {
            mostrarNotificacao('Serviço de IA indisponível. Faça login no popup da extensão.', 'erro');
            return null;
        }

        console.log("[Chatplay Assistant] 🌐 Gerando sugestões via backend...");
        const { categoria, confianca } = classificarIntencaoComConfianca(pergunta);

        const result = await BackendAPI.generateSuggestions({
            context:            contexto,
            question:           pergunta,
            category:           categoria,
            categoryConfidence: confianca,
            topExamples:        getMelhoresRespostas(categoria, 3),
            avoidPatterns:      AppState.sugestoesDesaprovadas.padroes.slice(0, 5).map(p => p.palavra),
        });

        const respostas = result.suggestions.map(s => s.text || s);
        AppState._lastSuggestions   = respostas;
        AppState._lastSuggestionIds = result.suggestions.map(s => s.id).filter(Boolean);

        BackendAPI.logEvent('suggestion.generated', {
            category:           result.category || categoria,
            categoryConfidence: result.confidence ?? confianca,
            lowConfidence:      result.lowConfidence ?? false,
            count:              respostas.length,
            latencyMs:          result.latencyMs,
        });

        return respostas;

    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro na API:", error);
        mostrarNotificacao(`❌ Erro na API: ${error.message}`, "erro");
        return null;
    } finally {
        isGenerating = false;
    }
}

async function gerarRespostaChat(mensagem) {
    // Garantir token em memória antes de bloquear
    if (!CONFIG.BACKEND_TOKEN) {
        try {
            const stored = await chrome.storage.local.get(['backend_token_v1', 'chatplay_backend_url']);
            if (stored['backend_token_v1'])     CONFIG.BACKEND_TOKEN = stored['backend_token_v1'];
            if (stored['chatplay_backend_url']) CONFIG.BACKEND_URL   = stored['chatplay_backend_url'];
        } catch (_) { /* ignorar se não tiver chrome.storage */ }
    }
    if (!CONFIG.BACKEND_TOKEN) {
        return "Faça login no popup da extensão para usar o chat IA.";
    }

    try {
        console.log("[Chatplay Assistant] 🌐 Enviando mensagem para o chat via backend...");

        const history = AppState.chatMessages
            .slice(-6)
            .map(m => ({
                role:    m.role    || (m.tipo === 'usuario' ? 'user' : 'assistant'),
                content: m.content || m.texto || '',
            }))
            .filter(m => m.content.trim() !== '');

        const mensagensCapturadas = capturarMensagens();
        const contexto = mensagensCapturadas.length > 0
            ? mensagensCapturadas.map(m => `${m.autor}: ${m.texto}`).join("\n")
            : "";

        const result = await BackendAPI.chatReply({ message: mensagem, history, context: contexto });
        return result.reply;

    } catch (error) {
        console.error("[Chatplay Assistant] ❌ Erro na API do chat:", error);
        return "❌ Erro ao comunicar com a IA. Verifique sua conexão.";
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

        const contexto = mensagens.map(m => `${m.autor}:\n${m.texto}`).join("\n\n")
            + `\n\nCLIENTE (MENSAGEM PRINCIPAL):\n${pergunta}`;

        const { categoria } = classificarIntencaoComConfianca(pergunta);

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
            sugestaoSelecionadaAtual = null;

            adicionarMensagemAoChat("assistant", JSON.stringify(respostas), "sugestoes", {
                source:   encontrado ? "history" : "fresh",
                question: pergunta,
                context:  contexto,
                category: categoria,
            });
            AppState.ultimaPergunta = pergunta;

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

/* ══════════════════════════════════════════════════════════════
   [M7] MODULE: HistoryManager
   Histórico de perguntas/respostas com busca por similaridade.
══════════════════════════════════════════════════════════════ */

function salvarNoHistorico(pergunta, respostas, contexto) {
    let registro = {
        id:        Date.now(),
        pergunta,
        tokens:    tokenizar(pergunta),
        categoria: classificarIntencao(pergunta),
        contexto:  contexto.substring(0, 500),
        respostas,
        data:      new Date().toISOString(),
    };

    AppState.historico.push(registro);
    console.log(`[Chatplay Assistant] 💾 SALVO NO HISTÓRICO - Pergunta: "${pergunta.substring(0, 70)}..."`);

    if (AppState.historico.length > CONFIG.MAX_HISTORY_SIZE) {
        AppState.historico = AppState.historico.slice(-CONFIG.MAX_HISTORY_SIZE);
    }

    storageUpdate(STORAGE_KEYS.HISTORICO, () => AppState.historico, []);
}

function buscarNoHistorico(pergunta) {
    console.log("[Chatplay Assistant] 🔍 Buscando no histórico...");

    let melhorItem  = null;
    let melhorScore = 0;

    for (let item of AppState.historico) {
        let score = calcularSimilaridadeSemantica(pergunta, item.pergunta);
        if (score > melhorScore) { melhorScore = score; melhorItem = item; }
    }

    if (melhorScore >= CONFIG.SIMILARITY_THRESHOLD) {
        console.log(`[Chatplay Assistant] 📚 USOU HISTÓRICO - Similaridade: ${(melhorScore * 100).toFixed(1)}%`);
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
            if (padroesMap.has(palavra)) padroesMap.get(palavra).contagem++;
            else padroesMap.set(palavra, { palavra, contagem: 1 });
        });
    });

    AppState.sugestoesDesaprovadas.padroes = Array.from(padroesMap.values())
        .filter(p => p.contagem > 1)
        .sort((a, b) => b.contagem - a.contagem)
        .slice(0, 100);

    storageUpdate(STORAGE_KEYS.DESAPROVADAS, () => AppState.sugestoesDesaprovadas, { respostas: [], categorias: {}, padroes: [] });
    mostrarNotificacao("✅ Resposta desaprovada excluída!");
}

/* ══════════════════════════════════════════════════════════════
   [M8] MODULE: ChatEngine
   Gerenciamento de mensagens do chat interno do assistente.
══════════════════════════════════════════════════════════════ */

function adicionarMensagemAoChat(role, conteudo, tipo = "texto", meta = null) {
    let mensagem = {
        role,
        content:   conteudo,
        tipo,
        timestamp: Date.now(),
        meta:      meta || undefined,
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
        await carregarConhecimentoCoren();
        await carregarConhecimentoChat();
        let resposta = await gerarRespostaChat(mensagem);
        removerDigitacao();
        adicionarMensagemAoChat("assistant", resposta);
    } catch (error) {
        removerDigitacao();
        adicionarMensagemAoChat("assistant", "❌ Erro ao processar sua mensagem. Tente novamente.");
        console.error("[Chatplay Assistant] ❌ Erro no chat:", error);
    }
}


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
        <span class="cpa-panel-brand-name">AssistentePlay
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
            AssistentePlay
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
