# Fase 1 — Arquitetura Alvo: AssistentePlay Extensão (Thin Client)

> **Repositório:** `clebermitho/Extensao`
> **Versão de referência:** 9.2.0
> **Data:** 2026-04-02
> **Depende de:** `docs/fase-0-diagnostico-tecnico.md`

---

## 1. Princípio Diretriz: Thin Client

A extensão **não é** (e não deve ser) um cliente de IA. Ela é uma **ponte de interface** entre o operador de atendimento e o backend centralizado.

| Responsabilidade | Onde fica (alvo) |
|---|---|
| Orquestração de LLM | Backend (`/v1/ai/*`) |
| Busca e indexação de conhecimento | Backend + knowledge-base pipeline |
| Classificação semântica robusta de intenção | Backend (`/v1/ai/classify`) |
| Similaridade vetorial (embeddings) | Backend |
| Cache de contexto com TTL e invalidação | Backend (Redis/cache layer) |
| Aprendizado de templates e scores | Backend (compartilhado por organização) |
| Autenticação e refresh de token | `background.js` (mantido) |
| Captura de DOM e relay de mensagens | `content_script.js` + `chatplay_core.js` (mantido) |
| Estado de UI efêmero | `chatplay_core.js` (mantido) |
| **Cache local mínimo** (respostas recentes, settings, TTL curto) | `chrome.storage.local` (reduzido) |

---

## 2. Diagrama Textual do Fluxo Alvo

```
┌─────────────────────────────────────────────────────────────────────┐
│  EXTENSÃO (Thin Client)                                             │
│                                                                     │
│  content_script.js                                                  │
│    └─ captura DOM (mensagens do chat)                               │
│         └─► chatplay_core.js                                        │
│               ├─ [LOCAL] classificar intenção com confiança         │
│               │    ├─ confiança ≥ threshold → envia categoria       │
│               │    └─ confiança < threshold → envia sem categoria   │
│               ├─ [LOCAL] busca em cache mínimo (TTL 5 min)          │
│               │    ├─ HIT → exibe sugestões cached                  │
│               │    └─ MISS → BackendAPI.request()                   │
│               └─ UI: renderiza, coleta feedback                     │
│                                                                     │
│  background.js (Service Worker)                                     │
│    ├─ proxy autenticado com refresh automático (mantido)            │
│    └─ heartbeat (mantido)                                           │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ BACKEND_REQUEST (chrome.runtime.sendMessage)
                          │ Authorization: Bearer <token>
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  BACKEND (/v1 — orquestrador central)                               │
│                                                                     │
│  POST /v1/ai/suggestions                                            │
│    ├─ classificação semântica de intenção (NLP robusto)             │
│    ├─ busca vetorial no knowledge base (RAG)                        │
│    ├─ orquestração de LLM com prompt versionado                     │
│    ├─ fallback controlado (timeout / rate limit / modelo)           │
│    └─ retorna: { suggestions[], category, confidence, latencyMs }   │
│                                                                     │
│  POST /v1/ai/chat                                                   │
│    ├─ contexto injetado pelo backend via RAG                        │
│    └─ retorna: { reply, contextUsed[], model }                      │
│                                                                     │
│  POST /v1/ai/classify         ← NOVO                               │
│    └─ retorna: { category, confidence, alternatives[] }             │
│                                                                     │
│  GET  /v1/knowledge/context   ← NOVO                               │
│    └─ busca contexto relevante sob demanda (sem JSON completo)      │
│                                                                     │
│  GET  /v1/settings            (já existe como /api/settings)        │
│  POST /v1/feedback            (já existe como /api/feedback)        │
│  GET  /v1/metrics/summary     (já existe como /api/metrics/summary) │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SERVIÇOS DE IA / CONHECIMENTO                                      │
│    ├─ LLM Provider (OpenAI / Anthropic / etc.)                      │
│    ├─ Embedding Model (para similaridade semântica)                 │
│    └─ Knowledge Base (indexada, versionada, com busca vetorial)     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. O Que Fica no Client vs. O Que Migra para o Backend

### 3.1 Mantido no client (thin client justificado)

| Componente | Justificativa |
|---|---|
| Captura de DOM (`chat_capture.js`) | Necessário — extensão é o único ponto com acesso ao DOM da página do Chatplay |
| Inserção no campo de chat (`inserirNoCampoChatPlay`) | Necessário — manipulação de DOM React via nativeSetter |
| Proxy autenticado (`background.js`) | Necessário — Service Worker como proxy resolve CORS e centraliza refresh de token |
| UI de sugestões e chat interno (`chatplay_core.js` UI) | Necessário — renderização na página do operador |
| Login flutuante (`content_script.js`) | Necessário — UX de autenticação in-page sem abrir popup |
| `classificarIntencao` local (heurística leve) | **Condicional:** mantida como pré-filtro de baixo custo para envio de categoria ao backend; o backend valida e retorna a classificação final com confiança |
| Cache local mínimo (`chrome.storage.local`, TTL 5 min) | Justificado — reduz latência em perguntas repetidas dentro da mesma sessão de atendimento |

### 3.2 Migra para o backend

| Componente | Justificativa da migração |
|---|---|
| Carregamento dos JSONs `base_coren.json` e `programação ia.json` | Dead code confirmado; knowledge base deve ser indexada e consultada via API (RAG) |
| Similaridade semântica vetorial | Bag-of-words local é imprecisa; embeddings no backend são mais eficientes e compartilhados |
| Aprendizado de templates por organização | Local não é compartilhado; backend pode agregar aprendizado de todos os operadores |
| Scores de respostas (acertos/erros) | Idem — escopo organizacional exige backend |
| Histórico de perguntas/respostas (pesado) | Reduzir para cache local mínimo + histórico no backend |

---

## 4. Estratégias Alvo

### 4.1 Contexto sob demanda (on-demand knowledge retrieval)

**As-is:** Dois JSONs completos carregados na inicialização do chat, sem uso efetivo.

**To-be:**
- A extensão envia ao backend: `{ message, context (DOM), category? }`
- O backend realiza a busca vetorial no knowledge base e injeta o contexto relevante no prompt
- A extensão **nunca** carrega o knowledge base completo
- Endpoint alvo: `GET /v1/knowledge/context?query=<texto>&limit=5`

```javascript
// Uso previsto em backend_api.js (alvo):
async getKnowledgeContext(query, { limit = 5, category = null } = {}) {
    const params = new URLSearchParams({ query, limit });
    if (category) params.set('category', category);
    return this.request(`/v1/knowledge/context?${params}`);
}
```

### 4.2 Cache local mínimo com TTL e invalidação

**As-is:** Cache em memória sem TTL (`_cacheCoren`, `_cacheChat`); histórico local sem TTL.

**To-be:**

| Dado | TTL | Invalidação | Armazenamento |
|---|---|---|---|
| Settings da organização | 10 min | `CONFIG_UPDATED` message ou restart | `chrome.storage.local` |
| Sugestões geradas para uma pergunta específica | 5 min | Novo contexto detectado (nova mensagem do cliente) | Memória (não persistida) |
| Templates aprendidos localmente | Sem TTL | Sincronização com backend a cada login | `chrome.storage.local` |
| Histórico de perguntas/respostas | 7 dias (LRU) | Limpeza automática ao ultrapassar 200 entradas | `chrome.storage.local` |
| Respostas desaprovadas | 30 dias | Sincronização com backend | `chrome.storage.local` |

**Implementação do cache de sugestões em memória com TTL:**

```javascript
// Alvo: cache simples com TTL de 5 minutos para sugestões recentes
const _suggestionsCache = new Map(); // key: hash(pergunta) → { suggestions, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedSuggestions(pergunta) {
    const key = normalizar(pergunta).substring(0, 100);
    const entry = _suggestionsCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _suggestionsCache.delete(key);
        return null;
    }
    return entry.suggestions;
}

function setCachedSuggestions(pergunta, suggestions) {
    const key = normalizar(pergunta).substring(0, 100);
    if (_suggestionsCache.size > 50) {
        // Evict oldest entry
        const oldest = [..._suggestionsCache.entries()]
            .sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) _suggestionsCache.delete(oldest[0]);
    }
    _suggestionsCache.set(key, { suggestions, ts: Date.now() });
}
```

### 4.3 Classificação de intenção e similaridade robusta (híbrida/semântica)

**As-is:** Heurística de palavras-chave local sem confiança, sem fallback.

**To-be (arquitetura híbrida):**

```
Pergunta do cliente
     │
     ▼
[CLIENT] classificarIntencaoComConfianca(pergunta)
     ├─ confiança ≥ 0.7 → categoria local enviada ao backend como hint
     └─ confiança < 0.7 → sem categoria (backend classifica do zero)
                                   │
                                   ▼
                    [BACKEND] POST /v1/ai/suggestions
                         ├─ recebe { context, question, categoryHint? }
                         ├─ NLP robusto (modelo de classificação ou LLM)
                         ├─ retorna { suggestions[], category, confidence }
                         │
                         ├─ confidence < 0.5 → ativa fallback
                         │    └─ retorna sugestões genéricas + flag `lowConfidence: true`
                         └─ confidence ≥ 0.5 → sugestões específicas da categoria
```

**Vantagens da abordagem híbrida:**
- A heurística local é um pré-filtro barato (< 1ms); reduz round-trips ao backend para casos triviais
- O backend tem a palavra final e retorna a confiança real
- O client pode usar `lowConfidence: true` para exibir aviso ao operador
- Sem breaking change: o campo `categoryHint` é opcional

**Trade-off:** Dois pontos de classificação podem divergir. Mitigação: o client usa o resultado do backend (mais preciso) para atualizar o `categoryHint` na próxima requisição.

### 4.4 Fallback quando confiança estiver baixa

**As-is:** Não há fallback explícito — `"OUTROS"` é retornado silenciosamente.

**To-be:**

| Situação | Comportamento alvo |
|---|---|
| Backend retorna `confidence < 0.5` | Exibir sugestões com badge "⚠️ Baixa confiança" + botão para reformular |
| Backend inacessível (rede offline) | Tentar cache local recente; se não houver, exibir mensagem clara com botão de retry |
| Backend retorna erro 503 | Modo degradado: exibir templates locais da categoria + aviso de "usando modo offline" |
| Backend retorna erro 429 (rate limit) | Retry com backoff exponencial (2s, 4s, 8s); notificar se persistir |
| Timeout (> 10s) | Cancelar request, exibir sugestões do histórico local se disponíveis + aviso |

### 4.5 Tratamento offline / retry / erro amigável

**As-is:** Sem timeout; erros genéricos; sem retry; sem modo offline estruturado.

**To-be:**

```javascript
// Alvo: wrapper de request com timeout e retry
async function requestWithRetry(path, options, { maxRetries = 2, timeoutMs = 10000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const signal = AbortSignal.timeout(timeoutMs);
            return await BackendAPI.request(path, { ...options, signal });
        } catch (err) {
            lastError = err;
            if (err.name === 'AbortError') break;          // timeout → não retry
            if (err.status === 401 || err.status === 403) break; // auth error → não retry
            if (err.status === 429 && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2 ** attempt * 2000)); // backoff
                continue;
            }
            break;
        }
    }
    throw lastError;
}
```

**Mensagens de erro amigáveis (alvo):**

| Cenário | Mensagem para o operador |
|---|---|
| Sem internet | "📵 Sem conexão. Suas últimas sugestões estão disponíveis abaixo." |
| Backend offline | "⚠️ Serviço temporariamente indisponível. Tente novamente em alguns segundos." |
| Sessão expirada | "🔑 Sua sessão expirou. Faça login novamente no ícone da extensão." |
| Timeout | "⏱️ Demora incomum na resposta. Verifique sua conexão." |
| Erro genérico | "❌ Erro ao gerar sugestões. [Tentar novamente]" |

---

## 5. Plano de Migração: Remoção dos JSONs Locais

**Objetivo:** Eliminar `carregarConhecimentoCoren()` e `carregarConhecimentoChat()` sem quebrar o fluxo existente.

**Status atual:** Os dois métodos são **chamados mas os retornos são ignorados** (dead code confirmado). A migração é, portanto, de baixo risco.

### Passo 1 — Remover as chamadas mortas (sem breaking change)

```javascript
// chatplay_core.js — BEFORE (linhas 393-395)
async function enviarMensagemChat(mensagem) {
    // ...
    await carregarConhecimentoCoren();   // ← remover
    await carregarConhecimentoChat();    // ← remover
    let resposta = await gerarRespostaChat(mensagem);
```

```javascript
// chatplay_core.js — AFTER
async function enviarMensagemChat(mensagem) {
    // ...
    let resposta = await gerarRespostaChat(mensagem);
```

**Impacto:** Zero — o retorno nunca foi usado. Remove ≈ 200ms–2s de latência desnecessária por mensagem.

### Passo 2 — Deprecar e remover `knowledge_base.js` (após Passo 1)

O módulo `knowledge_base.js` pode ser removido após o Passo 1, pois não terá mais chamadores.
Remover também o import em `chatplay_core.js` e da lista `web_accessible_resources` no `manifest.json`.

### Passo 3 — Adicionar endpoint de contexto sob demanda no backend

O backend deve implementar `GET /v1/knowledge/context?query=&category=&limit=` que:
- Aceita uma query em linguagem natural
- Retorna os chunks relevantes do knowledge base (RAG)
- Não expõe o JSON completo

**Rollback:** Se o endpoint não estiver disponível, o backend já usa seu próprio contexto interno (situação atual em `/api/ai/chat`). Não há regressão.

### Compatibilidade e Rollout Gradual

| Etapa | Ação | Risco |
|---|---|---|
| 1 | Remover chamadas mortas (`carregarConhecimento*`) | ✅ Zero risco — dead code confirmado |
| 2 | Deprecar `knowledge_base.js` | ✅ Baixo — sem chamadores após etapa 1 |
| 3 | Implementar `GET /v1/knowledge/context` no backend | 🟡 Médio — novo endpoint, testar integração |
| 4 | Atualizar `BackendAPI.chatReply()` para usar contexto do backend | 🟡 Médio — mudança no payload; backward compatible se `context` for opcional no backend |

---

## 6. Contratos Novos Propostos (Extensão → Backend `/v1`)

### 6.1 `POST /v1/ai/suggestions`

```
Request (atual → alvo):
{
  "context": "...",
  "question": "...",
  "category": "NEGOCIACAO",           // atual: enviado pelo client
  "categoryHint": "NEGOCIACAO",       // alvo: renomear para hint (opcional)
  "confidence": 0.72,                 // NOVO: confiança da classificação local
  "topExamples": ["..."],
  "avoidPatterns": ["..."]
}

Response (atual → alvo):
{
  "suggestions": [{ "id": "...", "text": "..." }],
  "latencyMs": 320,
  "category": "NEGOCIACAO",           // NOVO: categoria validada pelo backend
  "confidence": 0.88,                 // NOVO: confiança da classificação do backend
  "lowConfidence": false,             // NOVO: flag de baixa confiança
  "model": "gpt-4o-mini",            // NOVO: modelo usado (observabilidade)
  "fallbackUsed": false               // NOVO: se fallback foi acionado
}
```

### 6.2 `POST /v1/ai/chat`

```
Request (atual → alvo):
{
  "message": "...",
  "history": [...],
  "context": "...",                   // atual: contexto do DOM (mantido)
  "knowledgeQuery": "..."             // NOVO (opcional): query para RAG no backend
}

Response (atual → alvo):
{
  "reply": "...",
  "contextUsed": ["chunk1", "..."],   // NOVO: trechos do knowledge base usados
  "model": "gpt-4o-mini"             // NOVO: observabilidade
}
```

### 6.3 `POST /v1/ai/classify` (novo endpoint)

```
Request:
{
  "text": "quero cancelar minha inscrição",
  "context": "..."                    // opcional: histórico de conversa
}

Response:
{
  "category": "CANCELAMENTO",
  "confidence": 0.91,
  "alternatives": [
    { "category": "SUSPENSAO", "confidence": 0.12 }
  ]
}
```

### 6.4 `GET /v1/knowledge/context` (novo endpoint)

```
Query params:
  query     : string  (obrigatório) — texto para busca semântica
  category  : string  (opcional)   — filtrar por categoria
  limit     : number  (opcional, default 5) — máximo de chunks retornados

Response:
{
  "chunks": [
    {
      "id": "coren-001",
      "text": "...",
      "source": "base_coren",
      "relevance": 0.87
    }
  ]
}
```

---

## 7. Resumo Antes × Depois

| Aspecto | Antes (as-is) | Depois (to-be) |
|---|---|---|
| **Knowledge base** | JSONs completos carregados no client (GitHub raw) — dead code | Consulta incremental via `GET /v1/knowledge/context` |
| **Classificação de intenção** | Heurística local, sem confiança, sem fallback | Híbrida: heurística local como hint + classificação semântica robusta no backend |
| **Similaridade** | Bag-of-words local (TF-IDF simples) | Embeddings vetoriais no backend; cache local TTL 5min para hit imediato |
| **Fallback** | Retorno silencioso de `"OUTROS"` | Fallback explícito com `lowConfidence`, templates locais e mensagens claras ao operador |
| **Timeout** | Ausente (backend pode travar a UI) | `AbortSignal.timeout(10s)` + retry com backoff |
| **Cache** | Em memória sem TTL; histórico pesado sem expiração | TTL explícito por tipo; histórico reduzido (200 → 50 entradas) + backend como fonte de verdade |
| **Aprendizado** | Local, por dispositivo | Centralizado no backend por organização |
| **Segredos** | Nenhum exposto no client (correto — mantido) | Mantido — nenhum segredo no client |
| **Versionamento API** | `/api/*` sem versão | `/v1/*` com versionamento explícito |
| **Observabilidade** | Logs de console; `totalEconomiaAPI` incremental | `model`, `confidence`, `latencyMs`, `fallbackUsed` em cada resposta |

---

## 8. Decisões Técnicas e Trade-offs

| Decisão | Justificativa | Trade-off |
|---|---|---|
| Manter heurística local como hint (não removê-la) | Custo zero em latência; funciona para 75–85% dos casos diretos; reduz carga no backend | Mantém código local que precisa de manutenção; pode divergir da classificação do backend |
| Cache de sugestões em memória (não em `chrome.storage`) | Evita serialização/desserialização; dados de sessão sem necessidade de persistência | Perdido ao fechar a aba; não compartilhado entre abas |
| Migração incremental dos JSONs (remover chamadas → remover módulo) | Sem breaking change; verificável em etapas | Migração em 2+ PRs aumenta período de limpeza |
| `categoryHint` opcional no request ao backend | Backward compatible; backend pode ignorar e classificar por conta própria | Não garante que o backend use o hint |
| Histórico local de 50 entradas (vs. 1000 atual) | Reduz uso de `chrome.storage` e privacidade (dados sensíveis de atendimento) | Menos cache hit para perguntas repetidas após semanas |
| Timeout de 10s nas chamadas de backend | Evita UI travada; adequado para LLM (P95 esperado < 5s) | Pode falhar em conexões lentas com backend lento |

---

## 9. Riscos e Mitigação

| Risco | Mitigação |
|---|---|
| Backend não implementa `/v1/*` no mesmo sprint | Manter `/api/*` como fallback; migrar gradualmente path a path |
| `POST /v1/ai/suggestions` sem `confidence` no response | Extension tolera ausência do campo; exibe sugestões normalmente sem badge de confiança |
| Remoção do cache do histórico local reduz performance percebida | TTL de 5min em memória mantém hit rate para sessões de atendimento curtas (< 30 min) |
| Operadores em rede instável | Timeout + retry + fallback para templates locais + mensagem clara |
| Mudança de threshold de similaridade (0.65) sem calibração | Documentar e coletar métricas antes de alterar; threshold atual mantido como padrão |

---

## 10. Checklist de Aceite desta Fase

- [x] Diagnóstico as-is documentado (`fase-0-diagnostico-tecnico.md`)
- [x] Arquitetura alvo to-be definida (este documento)
- [x] Inventário dos contratos atuais consumidos (seção 4 do fase-0)
- [x] Análise da heurística atual com limitações concretas (seção 5 do fase-0)
- [x] Proposta de evolução híbrida com trade-offs (seção 4.3 deste documento)
- [x] Boundary client × backend definido (seção 3 deste documento)
- [x] Plano de migração dos JSONs sem breaking change (seção 5 deste documento)
- [x] Resumo Antes × Depois (seção 7 deste documento)
- [x] Decisões técnicas e trade-offs (seção 8 deste documento)
- [x] Riscos e mitigação (seção 9 deste documento)
- [x] Baseline de qualidade definido (seção 7 do fase-0)
- [ ] Implementação: `classificarIntencaoComConfianca()` — habilitador de fallback (código)
- [ ] Implementação: TTL em `knowledge_base.js` (migração preparatória)
- [ ] Implementação: `getKnowledgeContext()` stub em `backend_api.js` (contrato futuro)
- [ ] Fase 4: substituição completa das heurísticas locais por classificação híbrida/semântica
