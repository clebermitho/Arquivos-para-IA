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
 *   4. Janela flutuante de login:
 *      - Aparece automaticamente no canto superior direito se não autenticado
 *      - Intercepta cliques no botão do chat IA quando não autenticado
 *      - Fecha ao logar com sucesso; reabre se tentar usar o chat sem autenticação
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

    console.log('[AssistentePlayExt] ⚡ DOM pronto. Carregando chatplay_core.js...');

    try {
        _coreModule = await import(chrome.runtime.getURL('src/chatplay_core.js'));
        console.log('[AssistentePlayExt] ✅ Core carregado. Chamando inicializar()...');
        await _coreModule.inicializar();
        console.log('[AssistentePlayExt] 🚀 AssistentePlay v9.2.0 ativo!');
    } catch (err) {
        console.error('[AssistentePlayExt] ❌ Erro ao carregar chatplay_core.js:', err);
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
            console.warn('[AssistentePlayExt] ⏱ Timeout — carregando core sem seletor confirmado.');
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
            else console.warn('[AssistentePlayExt] Botão principal não encontrado.');
            sendResponse({ ok: true });
            break;
        }

        // Popup fez login → propaga novo token ao core sem reload de página
        case 'AUTH_UPDATED': {
            const { token } = message.payload || {};
            if (token && _coreModule?.setAuthToken) {
                _coreModule.setAuthToken(token);
                console.log('[AssistentePlayExt] 🔑 Token de autenticação atualizado no core.');
            }
            _isAuthenticated = !!token;
            if (_isAuthenticated) _hideLoginWindow();
            sendResponse({ ok: true });
            break;
        }

        // Popup fez logout → limpa token do core
        case 'AUTH_CLEARED': {
            if (_coreModule?.setAuthToken) {
                _coreModule.setAuthToken(null);
                console.log('[AssistentePlayExt] 🔒 Token de autenticação removido do core.');
            }
            _isAuthenticated = false;
            sendResponse({ ok: true });
            break;
        }

        // Config atualizada (ex: BACKEND_URL mudou no popup)
        case 'CONFIG_UPDATED': {
            const { backendUrl } = message.payload || {};
            if (backendUrl && _coreModule?.setBackendUrl) {
                _coreModule.setBackendUrl(backendUrl);
                console.log('[AssistentePlayExt] ⚙️ BACKEND_URL atualizado:', backendUrl);
            }
            if (backendUrl) _floatBackendUrl = backendUrl;
            sendResponse({ ok: true });
            break;
        }

        default:
            sendResponse({ ok: false, error: `Tipo desconhecido: ${message.type}` });
    }
});

// ── Janela flutuante de login ─────────────────────────────────

const _FL_STORAGE_TOKEN   = 'backend_token_v1';
const _FL_STORAGE_REFRESH = 'backend_refresh_token_v1';
const _FL_STORAGE_URL     = 'chatplay_backend_url';
const _FL_DEFAULT_BACKEND = 'https://backend-assistant-0x1d.onrender.com';

let _isAuthenticated  = false;
let _floatBackendUrl  = _FL_DEFAULT_BACKEND;
let _loginWin         = null;
let _loginStyleInjected = false;

/** Injeta o CSS da janela de login uma única vez. */
function _injectLoginStyle() {
    if (_loginStyleInjected) return;
    _loginStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'cpa-float-login-style';
    style.textContent = `
        #cpa-float-login {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2147483647;
            width: 272px;
            background: #161b27;
            border: 1px solid #1e2533;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,.65);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            color: #e2e8f0;
            overflow: hidden;
        }
        #cpa-float-login * { box-sizing: border-box; margin: 0; padding: 0; }
        #cpa-fl-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background: #0f1117;
            border-bottom: 1px solid #1e2533;
        }
        #cpa-fl-header span {
            font-size: 12px;
            font-weight: 600;
            color: #a5b4fc;
            letter-spacing: .02em;
        }
        #cpa-fl-close {
            background: none;
            border: none;
            color: #64748b;
            font-size: 14px;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 4px;
            line-height: 1;
            transition: color .15s, background .15s;
        }
        #cpa-fl-close:hover { color: #e2e8f0; background: #1e2533; }
        #cpa-fl-body { padding: 14px; }
        #cpa-fl-body label {
            display: block;
            font-size: 11px;
            color: #94a3b8;
            margin-bottom: 4px;
            margin-top: 10px;
        }
        #cpa-fl-body label:first-of-type { margin-top: 0; }
        #cpa-fl-credential,
        #cpa-fl-password {
            width: 100%;
            padding: 8px 10px;
            background: #0f1117;
            border: 1px solid #2d3748;
            border-radius: 6px;
            color: #e2e8f0;
            font-size: 12px;
            outline: none;
            transition: border-color .15s;
        }
        #cpa-fl-credential:focus,
        #cpa-fl-password:focus { border-color: #4f8ef7; }
        #cpa-fl-credential::placeholder,
        #cpa-fl-password::placeholder { color: #475569; }
        #cpa-fl-error {
            font-size: 11px;
            color: #ef4444;
            margin-top: 8px;
            min-height: 16px;
        }
        #cpa-fl-submit {
            width: 100%;
            margin-top: 12px;
            padding: 9px;
            background: linear-gradient(135deg, #4f8ef7, #6366f1);
            border: none;
            border-radius: 8px;
            color: #fff;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity .15s;
        }
        #cpa-fl-submit:hover:not(:disabled) { opacity: .9; }
        #cpa-fl-submit:disabled { opacity: .5; cursor: not-allowed; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

/** Cria o elemento DOM da janela de login flutuante. */
function _buildLoginWindow() {
    _injectLoginStyle();

    const el = document.createElement('div');
    el.id = 'cpa-float-login';
    el.innerHTML = `
        <div id="cpa-fl-header">
            <span>AssistentePlay — Login</span>
            <button id="cpa-fl-close" title="Fechar">✕</button>
        </div>
        <div id="cpa-fl-body">
            <label for="cpa-fl-credential">E-mail ou Usuário</label>
            <input id="cpa-fl-credential" type="text"
                   placeholder="seu@email.com ou username"
                   autocomplete="username" />
            <label for="cpa-fl-password">Senha</label>
            <input id="cpa-fl-password" type="password"
                   placeholder="••••••••"
                   autocomplete="current-password" />
            <div id="cpa-fl-error"></div>
            <button id="cpa-fl-submit">Entrar</button>
        </div>
    `;

    el.querySelector('#cpa-fl-close').addEventListener('click', () => {
        _hideLoginWindow();
    });

    el.querySelector('#cpa-fl-submit').addEventListener('click', () => {
        _doFloatLogin(el);
    });

    el.querySelector('#cpa-fl-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.querySelector('#cpa-fl-submit').click();
    });

    el.querySelector('#cpa-fl-credential').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.querySelector('#cpa-fl-password').focus();
    });

    return el;
}

/** Executa o login a partir da janela flutuante, roteando pelo background.js. */
async function _doFloatLogin(el) {
    const credVal   = el.querySelector('#cpa-fl-credential').value.trim();
    const password  = el.querySelector('#cpa-fl-password').value;
    const errorEl   = el.querySelector('#cpa-fl-error');
    const submitBtn = el.querySelector('#cpa-fl-submit');

    if (!credVal || !password) {
        errorEl.textContent = 'Preencha e-mail/usuário e senha.';
        return;
    }

    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Entrando…';

    try {
        const loginBody = credVal.includes('@')
            ? { email: credVal, password }
            : { username: credVal, password };

        // Roteado pelo background.js — centraliza autenticação em um único lugar
        const data = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'BACKEND_REQUEST', payload: { path: '/api/auth/login', method: 'POST', body: loginBody } },
                (response) => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    if (!response?.ok) return reject(new Error(response?.error || `HTTP ${response?.status}`));
                    resolve(response.data);
                }
            );
        });

        // Salvar token no storage
        const toSave = { [_FL_STORAGE_TOKEN]: data.token };
        if (data.refreshToken) toSave[_FL_STORAGE_REFRESH] = data.refreshToken;
        if (data.expiresAt)    toSave['chatplay_session_exp'] = data.expiresAt;
        await chrome.storage.local.set(toSave);

        // Notificar o core em memória
        if (_coreModule?.setAuthToken) _coreModule.setAuthToken(data.token);

        _isAuthenticated = true;
        _hideLoginWindow();
        console.log('[AssistentePlayExt] 🔑 Login realizado pela janela flutuante.');
    } catch (err) {
        errorEl.textContent = err.message || 'Credenciais inválidas.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Entrar';
    }
}

/** Exibe a janela flutuante de login (cria se necessário). */
function _showLoginWindow() {
    if (!_loginWin) {
        _loginWin = _buildLoginWindow();
    }
    if (!_loginWin.isConnected) {
        (document.body || document.documentElement).appendChild(_loginWin);
    }
    _loginWin.style.display = 'block';
}

/** Oculta a janela flutuante de login. */
function _hideLoginWindow() {
    if (_loginWin) _loginWin.style.display = 'none';
}

/** Verifica autenticação e exibe janela se necessário. */
function _initAuthWindow() {
    chrome.storage.local.get(
        [_FL_STORAGE_TOKEN, _FL_STORAGE_URL],
        (items) => {
            _isAuthenticated = !!items[_FL_STORAGE_TOKEN];
            if (items[_FL_STORAGE_URL]) _floatBackendUrl = items[_FL_STORAGE_URL];
            if (!_isAuthenticated) _showLoginWindow();
        }
    );
}

// Manter estado de autenticação sincronizado com mudanças no storage
chrome.storage.onChanged.addListener((changes) => {
    if (_FL_STORAGE_TOKEN in changes) {
        _isAuthenticated = !!changes[_FL_STORAGE_TOKEN].newValue;
        if (_isAuthenticated) _hideLoginWindow();
    }
    if (_FL_STORAGE_URL in changes) {
        _floatBackendUrl = changes[_FL_STORAGE_URL].newValue || _FL_DEFAULT_BACKEND;
    }
});

// Interceptar clique no botão do chat IA quando não autenticado
document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-chatplay-toggle]');
    if (toggle && !_isAuthenticated) {
        e.stopImmediatePropagation();
        _showLoginWindow();
    }
}, true);

// ── Iniciar bootstrap ─────────────────────────────────────────
if (document.body) {
    bootstrap();
    _initAuthWindow();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        bootstrap();
        _initAuthWindow();
    }, { once: true });
}
