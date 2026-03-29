/**
 * content_script.js — AssistentePlay v9.2.0
 *
 * Fluxo:
 *   1. MutationObserver aguarda o painel AssistentePlay estar presente no DOM.
 *   2. Quando detectado (ou timeout), importa chatplay_core.js e chama inicializar().
 *   3. Listener chrome.runtime.onMessage:
 *      - STATE_UPDATED   → core já trata via onChanged
 *      - OPEN_PANEL      → aciona botão principal do assistente
 *      - AUTH_UPDATED    → repassa token atualizado ao core em memória
 *      - AUTH_CLEARED    → limpa token do core (sessão encerrada via popup)
 *      - CONFIG_UPDATED  → atualiza BACKEND_URL no core sem reload
 */

'use strict';

// Seletor que identifica que o painel Chatplay está pronto no DOM
const CHATPLAY_SELECTORS = [
    '.chat-panel',
    '.chat-container',
    '#chat-area',
    '[data-chatplay]',
    '.chat-messages',
    '.atendimento-chat',
];

const MAX_WAIT_MS = 15000;  // 15 s — timeout de segurança
let _coreLoaded   = false;
let _coreModule   = null;   // referência ao módulo carregado (para relay de auth)

/**
 * isPanelReady — verifica se algum seletor do Chatplay está no DOM.
 */
function isPanelReady() {
    return CHATPLAY_SELECTORS.some(sel => document.querySelector(sel) !== null)
        || document.readyState === 'complete';
}

/**
 * loadCore — importa chatplay_core.js e chama inicializar().
 * Idempotente: não executa duas vezes mesmo com observer múltiplo.
 */
async function loadCore() {
    if (_coreLoaded) return;
    _coreLoaded = true;

    console.log('[ChatplayExt] ⚡ DOM pronto. Carregando chatplay_core.js...');

    try {
        _coreModule = await import(chrome.runtime.getURL('src/chatplay_core.js'));
        console.log('[ChatplayExt] ✅ Core carregado. Chamando inicializar()...');
        await _coreModule.inicializar();
        console.log('[ChatplayExt] 🚀 AssistentePlay v9.2.0 ativo!');
    } catch (err) {
        console.error('[ChatplayExt] ❌ Erro ao carregar chatplay_core.js:', err);
        _coreLoaded = false; // permite retry
    }
}

/**
 * Bootstrap via MutationObserver.
 */
function bootstrap() {
    if (isPanelReady()) {
        loadCore();
        return;
    }

    const observer = new MutationObserver(() => {
        if (isPanelReady()) {
            observer.disconnect();
            loadCore();
        }
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree:   true,
    });

    setTimeout(() => {
        if (!_coreLoaded) {
            observer.disconnect();
            console.warn('[ChatplayExt] ⏱ Timeout — carregando core sem seletor confirmado.');
            loadCore();
        }
    }, MAX_WAIT_MS);
}

// ── Listener: recebe mensagens do background.js e do popup ────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {

        // Fase C: outra aba atualizou o storage — core já reage via onChanged
        case 'STATE_UPDATED':
            sendResponse({ ok: true });
            break;

        // Popup pediu abertura do painel assistente
        case 'OPEN_PANEL': {
            const btn = document.querySelector('[data-chatplay-toggle]')
                     || document.getElementById('ai-botao-principal');
            if (btn) btn.click();
            else console.warn('[ChatplayExt] Botão principal não encontrado.');
            sendResponse({ ok: true });
            break;
        }

        // Popup fez login → propaga novo token ao core sem reload de página
        case 'AUTH_UPDATED': {
            const { token } = message.payload || {};
            if (token && _coreModule?.setAuthToken) {
                _coreModule.setAuthToken(token);
                console.log('[ChatplayExt] 🔑 Token de autenticação atualizado no core.');
            }
            sendResponse({ ok: true });
            break;
        }

        // Popup fez logout → limpa token do core
        case 'AUTH_CLEARED': {
            if (_coreModule?.setAuthToken) {
                _coreModule.setAuthToken(null);
                console.log('[ChatplayExt] 🔒 Token de autenticação removido do core.');
            }
            sendResponse({ ok: true });
            break;
        }

        // Config atualizada (ex: BACKEND_URL mudou no popup)
        case 'CONFIG_UPDATED': {
            const { backendUrl } = message.payload || {};
            if (backendUrl && _coreModule?.setBackendUrl) {
                _coreModule.setBackendUrl(backendUrl);
                console.log('[ChatplayExt] ⚙️ BACKEND_URL atualizado:', backendUrl);
            }
            sendResponse({ ok: true });
            break;
        }

        default:
            sendResponse({ ok: false, error: `Tipo desconhecido: ${message.type}` });
    }
});

// ── Iniciar bootstrap ─────────────────────────────────────────
if (document.body) {
    bootstrap();
} else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
}
