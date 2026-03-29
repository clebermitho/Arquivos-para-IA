/**
 * popup.js — AssistentePlay v9.2.0
 *
 * Fluxo:
 *   1. Carrega BACKEND_URL e BACKEND_TOKEN do chrome.storage
 *   2. Se token presente → valida com GET /api/auth/me
 *      a) Válido → mostra dashboard com stats
 *      b) 401/403 → mostra tela "sessão expirada"
 *   3. Se sem token → mostra formulário de login
 *
 * Views:
 *   - #view-login      → formulário de e-mail + senha + config de URL
 *   - #view-dashboard  → usuário logado + stats + botões
 *   - #view-expired    → sessão expirada com botão de relogin
 */
'use strict';

// ── Constantes ───────────────────────────────────────────────
const STORAGE_KEYS_POPUP = {
    BACKEND_TOKEN:   'backend_token_v1',
    REFRESH_TOKEN:   'backend_refresh_token_v1',
    BACKEND_URL:    'chatplay_backend_url',
    // legado (stats locais, usados apenas como fallback se backend offline)
    STATS:          'estatisticas_v7',
    TEMPLATES:      'templates_ia_v7',
    DESAPROVADAS:   'sugestoes_desaprovadas_v7',
};

const DEFAULT_BACKEND_URL = 'https://backend-assistant-0x1d.onrender.com';

// ── Estado local ─────────────────────────────────────────────
let state = {
    backendUrl: DEFAULT_BACKEND_URL,
    token:       null,
    refreshToken: null,
    user:        null,
    sessionExp:  null,   // ISO string de expiração
};

// ── Helpers de DOM ───────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showView(name) {
    ['login', 'dashboard', 'expired'].forEach(v => {
        const el = $(`view-${v}`);
        if (el) el.classList.toggle('active', v === name);
    });
}

function setStatus(text, dotClass = 'amber') {
    const dot   = $('status-dot');
    const label = $('status-label');
    dot.className   = `dot ${dotClass}${dotClass === 'amber' ? ' pulse' : ''}`;
    label.textContent = text;
}

function setBadge(text) {
    $('env-badge').textContent = text;
}

function setLoginError(msg) {
    const el = $('login-error');
    if (msg) {
        el.textContent = msg;
        el.classList.add('show');
    } else {
        el.textContent = '';
        el.classList.remove('show');
    }
}

function setLoginLoading(loading) {
    const btn = $('btn-login');
    btn.disabled     = loading;
    btn.innerHTML    = loading
        ? '<span class="spinner"></span>Entrando…'
        : 'Entrar';
}

// ── Chamadas ao backend ──────────────────────────────────────
async function apiRequest(path, options = {}) {
    const url = `${state.backendUrl}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(state.token ? { 'Authorization': `Bearer ${state.token}` } : {}),
        ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
}

async function pingBackend() {
    try {
        const res = await fetch(`${state.backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch { return false; }
}

// ── Carregamento de stats (backend + fallback local) ─────────
async function loadStats() {
    // Tentar stats do backend
    try {
        const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const summary = await apiRequest(`/api/metrics/summary?since=${encodeURIComponent(since)}`);
        $('stat-sugestoes').textContent = summary.suggestions?.total ?? '—';

        const tmpl = await apiRequest('/api/templates');
        $('stat-templates').textContent = tmpl.templates?.length ?? '—';

        const rej = await apiRequest('/api/feedback/rejected');
        $('stat-desap').textContent = rej.rejected?.length ?? '—';
        return;
    } catch { /* fallback para local */ }

    // Fallback: dados do chrome.storage local
    try {
        const data = await chrome.storage.local.get([
            STORAGE_KEYS_POPUP.STATS,
            STORAGE_KEYS_POPUP.TEMPLATES,
            STORAGE_KEYS_POPUP.DESAPROVADAS,
        ]);
        const stats    = data[STORAGE_KEYS_POPUP.STATS]       || {};
        const tmpl     = data[STORAGE_KEYS_POPUP.TEMPLATES]   || {};
        const desap    = data[STORAGE_KEYS_POPUP.DESAPROVADAS] || { respostas: [] };
        const totTmpl  = Object.values(tmpl).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);

        $('stat-sugestoes').textContent = stats.totalSugestoes    || '0';
        $('stat-templates').textContent = totTmpl                 || '0';
        $('stat-desap').textContent     = desap.respostas?.length || '0';
    } catch { /* silently fail */ }
}

// ── Exibição do usuário logado ───────────────────────────────
function renderUser(user) {
    // Avatar: iniciais do nome
    const initials = (user.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    $('user-avatar').textContent = initials;
    $('user-name').textContent   = user.name || user.email;
    $('user-role').textContent   = user.role || 'AGENT';

    // Sessão ativa
    $('stat-session').textContent = 'Ativa';
}

// ── Persistência do token ────────────────────────────────────
async function saveAuth(token, expiresAt, refreshToken) {
    state.token        = token;
    state.refreshToken = refreshToken || state.refreshToken;
    state.sessionExp   = expiresAt;
    const toSave = {
        [STORAGE_KEYS_POPUP.BACKEND_TOKEN]: token,
        chatplay_session_exp: expiresAt || null,
    };
    if (refreshToken) {
        toSave[STORAGE_KEYS_POPUP.REFRESH_TOKEN] = refreshToken;
    }
    await chrome.storage.local.set(toSave);
    notifyContentScript({ type: 'AUTH_UPDATED', payload: { token } });
}

async function clearAuth() {
    state.token      = null;
    state.user       = null;
    state.sessionExp = null;
    await chrome.storage.local.remove([
        STORAGE_KEYS_POPUP.BACKEND_TOKEN,
        STORAGE_KEYS_POPUP.REFRESH_TOKEN,
        'chatplay_session_exp',
    ]);
    notifyContentScript({ type: 'AUTH_CLEARED' });
}

function notifyContentScript(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url?.includes('chatplay.com.br')) {
            chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
        }
    });
}

// ── Fluxo principal de inicialização ────────────────────────
async function init() {
    // 1. Carregar URL + token do storage
    const data = await chrome.storage.local.get([
        STORAGE_KEYS_POPUP.BACKEND_URL,
        STORAGE_KEYS_POPUP.BACKEND_TOKEN,
        STORAGE_KEYS_POPUP.REFRESH_TOKEN,
        'chatplay_session_exp',
    ]);
    state.backendUrl = data[STORAGE_KEYS_POPUP.BACKEND_URL] || DEFAULT_BACKEND_URL;
    state.token        = data[STORAGE_KEYS_POPUP.BACKEND_TOKEN]  || null;
    state.refreshToken = data[STORAGE_KEYS_POPUP.REFRESH_TOKEN] || null;
    state.sessionExp = data['chatplay_session_exp'] || null;

    // Preencher campo de URL
    $('input-backend-url').value = state.backendUrl;

    // 2. Sem token → tela de login
    if (!state.token) {
        setStatus('Não autenticado', 'red');
        setBadge('offline');
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        showView('login');
        return;
    }

    // 3. Verificar se sessão já expirou localmente
    if (state.sessionExp && new Date(state.sessionExp) < new Date()) {
        await clearAuth();
        setStatus('Sessão expirada', 'amber');
        setBadge('expirado');
        showView('expired');
        return;
    }

    // 4. Validar token no backend
    setStatus('Verificando sessão…', 'amber');
    try {
        const me = await apiRequest('/api/auth/me');
        state.user = me.user || me;
        // Usar expiresAt retornado pelo backend (mais confiável que o armazenado)
        if (me.expiresAt) {
            state.sessionExp = me.expiresAt;
            await chrome.storage.local.set({ chatplay_session_exp: me.expiresAt });
        }
        setStatus(`Conectado — ${state.backendUrl.replace('https://', '').replace('http://', '')}`, 'green');
        setBadge('backend');
        chrome.action.setBadgeText({ text: '' });
        renderUser(state.user);
        await loadStats();
        showView('dashboard');
    } catch (err) {
        if (err.status === 401 || err.status === 403) {
            await clearAuth();
            setStatus('Sessão expirada', 'amber');
            setBadge('expirado');
            showView('expired');
        } else {
            // Backend inacessível mas token presente → mostra dashboard degradado
            setStatus('Backend offline — modo degradado', 'amber');
            setBadge('offline');
            // Tenta carregar stats locais
            const storedName = 'Usuário';
            $('user-avatar').textContent = '?';
            $('user-name').textContent   = storedName;
            $('user-role').textContent   = 'sem conexão';
            $('stat-session').textContent = 'Ativa';
            await loadStats();
            showView('dashboard');
        }
    }
}

// ── Handlers de eventos ──────────────────────────────────────

// Login
$('btn-login').addEventListener('click', async () => {
    const email    = $('input-email').value.trim();
    const password = $('input-password').value;

    if (!email || !password) {
        setLoginError('Preencha e-mail e senha.');
        return;
    }

    setLoginError(null);
    setLoginLoading(true);
    setStatus('Autenticando…', 'amber');

    try {
        const res = await apiRequest('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        state.user = res.user;
        await saveAuth(res.token, res.expiresAt, res.refreshToken);
        setStatus(`Conectado — ${state.backendUrl.replace('http://', '')}`, 'green');
        setBadge('backend');
        chrome.action.setBadgeText({ text: '' });
        renderUser(state.user);
        await loadStats();
        showView('dashboard');
    } catch (err) {
        setLoginError(err.message || 'Credenciais inválidas.');
        setStatus('Falha ao autenticar', 'red');
    } finally {
        setLoginLoading(false);
    }
});

// Enter no campo de senha faz login
$('input-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-login').click();
});

// Logout
$('btn-logout').addEventListener('click', async () => {
    try {
        await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch { /* ignora erro de rede */ }
    await clearAuth();
    setStatus('Sessão encerrada', 'red');
    setBadge('offline');
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    $('input-email').value    = '';
    $('input-password').value = '';
    showView('login');
});

// Relogin (sessão expirada)
$('btn-relogin').addEventListener('click', () => {
    setStatus('Faça login novamente', 'amber');
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    showView('login');
});

// Salvar URL do backend
$('btn-save-url').addEventListener('click', async () => {
    const url = $('input-backend-url').value.trim().replace(/\/$/, '');
    if (!url) return;
    state.backendUrl = url;
    await chrome.storage.local.set({ [STORAGE_KEYS_POPUP.BACKEND_URL]: url });
    $('btn-save-url').textContent = '✓';
    setTimeout(() => { $('btn-save-url').textContent = 'Salvar'; }, 1500);
    // Notifica content_script sobre nova URL
    notifyContentScript({ type: 'CONFIG_UPDATED', payload: { backendUrl: url } });
});

// Ping backend
$('btn-ping').addEventListener('click', async () => {
    $('btn-ping').textContent = '…';
    const ok = await pingBackend();
    $('btn-ping').textContent = ok ? '✓ ok' : '✗ err';
    setTimeout(() => { $('btn-ping').textContent = 'Ping'; }, 2000);
});

// Abrir painel Chatplay
$('btn-open-panel').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('chatplay.com.br')) {
        chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' }).catch(() => {});
        window.close();
    } else {
        chrome.tabs.create({ url: 'https://chatplay.com.br/panel/chatplay' });
    }
});

// ── Iniciar ──────────────────────────────────────────────────
init();
