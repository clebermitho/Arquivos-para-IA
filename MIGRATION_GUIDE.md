# Chatplay Assistant — Guia de Migração: Userscript → Extensão

## Status atual: Fase B ✅

A extensão está totalmente migrada para ES modules com separação de responsabilidades.
Os módulos puros (sem dependência de UI) estão em `src/modules/`.

---

## Arquitetura atual (Fase B concluída)

```
src/
├── background.js          ← Service Worker: proxy HTTP, autenticação, refresh token, broadcasts
├── content_script.js      ← Injeção na página, bridge de mensagens, janela de login flutuante
├── chatplay_core.js       ← Orquestrador: SuggestionEngine, HistoryManager, ChatEngine, UI, Bootstrap
├── storage_adapter.js     ← Mantido para compatibilidade (canonical: src/modules/storage.js)
└── modules/
    ├── config.js          ← M0: CONFIG, STORAGE_KEYS, STORAGE_ENV, DEFAULT_BACKEND_URL
    ├── state.js           ← AppState (estado global mutable compartilhado)
    ├── storage.js         ← M1: Adapters, _writeQueue, storageGet/Set/Update, carregarAppState
    ├── text_analysis.js   ← M2: normalizar, tokenizar, classificarIntencao, similaridade
    ├── chat_capture.js    ← M3 (leitura): capturarMensagens, descobrirAutor, detectarPergunta
    ├── knowledge_base.js  ← M4: carregarBaseConhecimento (cache em memória + fallback de transição)
    ├── backend_api.js     ← BackendAPI (roteado via background.js) + openAIBridge (dev)
    └── learning_engine.js ← M6: scores, templates, feedback, filtros de desaprovadas
```

### Por que `chatplay_core.js` ainda contém múltiplos módulos?

Os módulos M5 (SuggestionEngine), M7 (HistoryManager), M8 (ChatEngine) e M9 (UI) possuem
**dependências circulares**: SuggestionEngine chama funções de UI, e UI chama funções de
SuggestionEngine. Resolver isso exigiria uma camada de injeção de dependências (callbacks),
o que está documentado como evolução futura em Fase D.

---

## Fluxo de autenticação (centralizado em background.js)

```
popup.js          → POST /api/auth/login   (fetch direto — contexto do popup)
content_script.js → BACKEND_REQUEST msg → background.js → fetch → backend
chatplay_core.js  → BACKEND_REQUEST msg → background.js → fetch → backend
```

O `background.js` é o único responsável por:
- Injetar o `Authorization: Bearer` em todas as requisições
- Fazer refresh automático de token em respostas 401
- Persistir tokens atualizados no `chrome.storage`
- Fazer broadcast de `AUTH_UPDATED` para todas as abas

---

## Fase A (concluída) — Preparação no userscript

| O que foi feito | Onde |
|---|---|
| `StorageAdapter` com `GM_adapter` e `chrome_adapter` | `modules/storage.js` |
| `_writeQueue` mutex FIFO | `modules/storage.js` |
| `storageUpdate()` para operações RMW | `modules/storage.js` |
| `storageGetMany()` para leitura em batch | `modules/storage.js` |
| `carregarAppState()` async | `modules/storage.js` |
| `AppState` declarado vazio, populado via `carregarAppState()` | `modules/state.js` |
| `inicializar()` async com await | `chatplay_core.js` / M0 |
| `_inicializarOnChanged()` multi-aba | `modules/storage.js` |

---

## Fase B (concluída) — Migração para extensão Chrome

| O que foi feito | Onde |
|---|---|
| `STORAGE_ENV = "chrome"` ativo | `modules/config.js` |
| 8 módulos puros extraídos | `src/modules/*.js` |
| `BackendAPI.request()` roteado via `background.js` | `modules/backend_api.js` |
| `_doFloatLogin` roteado via `background.js` | `content_script.js` |
| Código morto (fallback OpenAI unreachable) removido | `chatplay_core.js` |
| `mostrarOpcoesLimpeza` (dead function) removido | `chatplay_core.js` |
| `web_accessible_resources` atualizado para módulos | `manifest.json` |

---

## Fase C (concluída) — Multi-aba e Sincronização

O listener `_inicializarOnChanged()` está ativo em `modules/storage.js`.

**Comportamento:**
- `STORAGE_KEYS.SCORES`: merge por `Math.max` (Last-Write-Wins por campo)
- `STORAGE_KEYS.LOG_SUGESTOES`: merge por categoria com deduplicação por `id`
- `STORAGE_KEYS.STATS`: merge por `Math.max` nos contadores

---

## Fase D (futura) — Separar UI dos motores de geração

Para separar completamente M5/M7/M8/M9 do `chatplay_core.js`, é necessário
quebrar a dependência circular UI ↔ SuggestionEngine usando injeção de dependências:

```js
// suggestion_engine.js — aceitar callbacks de UI como parâmetros
export function initDependencies({ notify, showTyping, hideTyping, addMessage }) { ... }
```

Isso preserva o comportamento mas exige atualizar as assinaturas de funções.

---

## Riscos e mitigações

| Risco | Mitigação implementada |
|---|---|
| Lost Update (escrita concorrente) | `_writeQueue` + `storageUpdate()` |
| AppState vazio na UI | `carregarAppState()` antes de `criarBotaoPrincipal()` |
| Race condition multi-aba | `_inicializarOnChanged()` com merge LWW |
| CORS na chamada OpenAI | `background.js` como proxy via `OPENAI_REQUEST` |
| Service Worker efêmero (MV3) | Todo estado em `chrome.storage`, não em memória |
| Falha de escrita travar a fila | `.catch(console.error)` no `_writeQueue` |
| Duplicate token refresh | BackendAPI roteia via background.js (centralizado) |
