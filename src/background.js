/**
 * background.js — AssistentePlay Service Worker v9.2.0
 *
 * Responsabilidades:
 *   - Proxy de chamadas ao backend autenticado (sem CORS no content_script)
 *   - Relay de mensagens de autenticação entre popup e content_script
 *   - Broadcast de atualizações de estado para todas as abas ativas
 *   - Heartbeat periódico ao backend para manter sessão ativa
 *
 * NOTA MV3: Service Workers são efêmeros — nenhum estado em memória
 * entre invocações. Todo estado persistente usa chrome.storage.local.
 */

'use strict';

const STORAGE_KEYS = {
    BACKEND_TOKEN:   'backend_token_v1',
    REFRESH_TOKEN:   'backend_refresh_token_v1',
    BACKEND_URL:     'chatplay_backend_url',
    SESSION_EXP:     'chatplay_session_exp',
};

const DEFAULT_BACKEND_URL = 'https://backend-assistant-0x1d.onrender.com';

// ── Heartbeat: envia ping periódico ao backend ────────────────
const HEARTBEAT_ALARM_NAME = 'chatplay_heartbeat';
const HEARTBEAT_INTERVAL_MIN = 5;

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
        await sendHeartbeat();
    }
});

async function sendHeartbeat() {
    try {
        const stored = await chrome.storage.local.get([
            STORAGE_KEYS.BACKEND_TOKEN,
            STORAGE_KEYS.BACKEND_URL,
        ]);
        const token = stored[STORAGE_KEYS.BACKEND_TOKEN];
        if (!token) return; // Não autenticado

        const baseUrl = stored[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND_URL;
        await fetch(`${baseUrl}/api/auth/heartbeat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
        });
    } catch (err) {
        // Falha silenciosa — heartbeat é best-effort
        console.warn('[AssistentePlayBG] Heartbeat falhou:', err.message);
    }
}

async function startHeartbeat() {
    await chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
        periodInMinutes: HEARTBEAT_INTERVAL_MIN,
    });
    // Enviar heartbeat imediato
    await sendHeartbeat();
}

async function stopHeartbeat() {
    await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
}

// ── Instalação / atualização ──────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    const msgs = {
        install: '🚀 AssistentePlay v9.2.0 instalado.',
        update:  '✅ AssistentePlay atualizado para v9.2.0.',
    };
    if (msgs[reason]) console.log('[AssistentePlayBG]', msgs[reason]);
    // Iniciar heartbeat se já autenticado
    const stored = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_TOKEN]);
    if (stored[STORAGE_KEYS.BACKEND_TOKEN]) {
        await startHeartbeat();
    }
});

// ── Listener de mensagens ─────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message;

    switch (type) {

        // ── Proxy autenticado ao backend (usado pelo core) ────
        case 'BACKEND_REQUEST':
            handleBackendRequest(payload)
                .then(data => sendResponse({ ok: true, data }))
                .catch(err => sendResponse({ ok: false, error: err.message, status: err.status }));
            return true;

        // ── Proxy legado OpenAI (fallback; apenas dev) ────────
        case 'OPENAI_REQUEST':
            handleOpenAIRequest(payload)
                .then(data => sendResponse({ ok: true, data }))
                .catch(err => sendResponse({ ok: false, error: err.message }));
            return true;

        // ── Auth: popup persistiu novo token → notifica tabs ─
        case 'AUTH_UPDATED':
            (async () => {
                broadcastToAllTabs({ type: 'AUTH_UPDATED', payload });
                await startHeartbeat();
                sendResponse({ ok: true });
            })();
            return true;

        // ── Auth: sessão encerrada → notifica tabs ────────────
        case 'AUTH_CLEARED':
            (async () => {
                broadcastToAllTabs({ type: 'AUTH_CLEARED' });
                await stopHeartbeat();
                sendResponse({ ok: true });
            })();
            return true;

        // ── Config atualizada (ex: nova BACKEND_URL) ──────────
        case 'CONFIG_UPDATED':
            broadcastToAllTabs({ type: 'CONFIG_UPDATED', payload });
            sendResponse({ ok: true });
            break;

        // ── Broadcast genérico de state ───────────────────────
        case 'BROADCAST_STATE_UPDATE':
            broadcastToAllTabs(payload);
            sendResponse({ ok: true });
            break;

        // ── Health check do popup ─────────────────────────────
        case 'PING':
            sendResponse({ ok: true, version: '9.2.0', env: 'chrome' });
            break;

        default:
            sendResponse({ ok: false, error: `Tipo desconhecido: ${type}` });
    }
});

// ── handleBackendRequest ──────────────────────────────────────
/**
 * Executa uma chamada HTTP ao backend usando o token do storage.
 * O content_script não pode fazer isso diretamente (CORS + host_permissions
 * para localhost só valem no background em algumas configs).
 *
 * @param {{ path: string, method?: string, body?: object }} payload
 */
async function handleBackendRequest({ path, method = 'GET', body = null }) {
    // Sempre relê token e URL do storage — nunca usa cache em memória (Service Worker é efêmero)
    const stored = await chrome.storage.local.get([
        STORAGE_KEYS.BACKEND_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.BACKEND_URL,
    ]);
    let token     = stored[STORAGE_KEYS.BACKEND_TOKEN];
    const baseUrl = stored[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND_URL;

    const doFetch = async (tk) => {
        const headers = {
            'Content-Type': 'application/json',
            ...(tk ? { 'Authorization': `Bearer ${tk}` } : {}),
        };
        return fetch(`${baseUrl}${path}`, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    };

    let res = await doFetch(token);

    // Refresh automático em 401 — evita "logado mas sem resposta"
    if (res.status === 401 && stored[STORAGE_KEYS.REFRESH_TOKEN]) {
        try {
            const rRes = await fetch(`${baseUrl}/api/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: stored[STORAGE_KEYS.REFRESH_TOKEN] }),
            });
            if (rRes.ok) {
                const rData = await rRes.json();
                token = rData.token;
                await chrome.storage.local.set({
                    [STORAGE_KEYS.BACKEND_TOKEN]: token,
                    ...(rData.expiresAt ? { [STORAGE_KEYS.SESSION_EXP]: rData.expiresAt } : {}),
                });
                // Notificar todas as abas sobre o token renovado
                broadcastToAllTabs({ type: 'AUTH_UPDATED', payload: { token } });
                res = await doFetch(token);
            }
        } catch (refreshErr) {
            console.warn('[AssistentePlayBG] Refresh falhou:', refreshErr.message);
        }
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        const err = new Error(data.error || `Backend HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// ── handleOpenAIRequest (legado / dev-only) ───────────────────
/**
 * Proxy de fallback para chamadas diretas à OpenAI.
 * Usado APENAS quando BACKEND_URL não está configurado (dev/debug).
 * Em produção, toda IA passa pelo backend.
 */
async function handleOpenAIRequest({ apiKey, messages, model = 'gpt-4o-mini', max_tokens = 500, temperature = 0.7 }) {
    console.warn('[AssistentePlayBG] ⚠️ Usando proxy OpenAI legado. Configure o backend para produção.');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, max_tokens, temperature }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const e = new Error(err?.error?.message || `HTTP ${response.status}`);
        throw e;
    }
    return response.json();
}

// ── broadcastToAllTabs ────────────────────────────────────────
async function broadcastToAllTabs(message) {
    const tabs = await chrome.tabs.query({ url: 'https://chatplay.com.br/panel/chatplay*' });
    tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
}
