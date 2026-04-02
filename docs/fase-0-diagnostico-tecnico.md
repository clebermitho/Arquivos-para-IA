# Fase 0 — Diagnóstico Técnico: AssistentePlay Extensão

> **Repositório:** `clebermitho/Extensao`
> **Versão analisada:** 9.2.0 (manifest.json)
> **Data:** 2026-04-02
> **Programa:** Modernização dos 4 repositórios do produto

---

## 1. Mapa de Módulos e Responsabilidades

### 1.1 Ponto de entrada e contextos de execução

| Contexto | Arquivo | Responsabilidade |
|---|---|---|
| **Service Worker** (background) | `src/background.js` | Proxy HTTP autenticado, refresh de token, heartbeat, broadcast para abas |
| **Content Script** | `src/content_script.js` | Injeção na página, MutationObserver, janela flutuante de login, relay de mensagens |
| **Orquestrador principal** | `src/chatplay_core.js` | SuggestionEngine (M5), HistoryManager (M7), ChatEngine (M8), UI (M9), Bootstrap (M0) |
| **Popup** | `popup.js` + `popup.html` | Autenticação, dashboard com stats, configuração de BACKEND_URL |
| **Storage Adapter** | `src/storage_adapter.js` | Mantido para compatibilidade reversa; canonical em `src/modules/storage.js` |

### 1.2 Módulos puros (`src/modules/`)

| Módulo | Arquivo | Responsabilidade |
|---|---|---|
| M0 — Config | `config.js` | Constantes globais: `CONFIG`, `STORAGE_KEYS`, `STORAGE_ENV`, `DEFAULT_BACKEND_URL` |
| M1 — State | `state.js` | `AppState` — objeto global mutável compartilhado; populado por `carregarAppState()` |
| M2 — Storage | `storage.js` | Adapters, `_writeQueue` FIFO mutex, `storageGet/Set/Update`, `_inicializarOnChanged()` |
| M3 — TextAnalysis | `text_analysis.js` | `normalizar`, `tokenizar` (TF-IDF simples), `extrairPalavrasChave`, `calcularSimilaridadeSemantica`, `classificarIntencao` |
| M4 — ChatCapture | `chat_capture.js` | `capturarMensagens` (leitura DOM), `descobrirAutor`, `detectarPergunta` |
| M5 — KnowledgeBase | `knowledge_base.js` | `carregarConhecimentoCoren` / `carregarConhecimentoChat` — fetch de JSONs externos com cache em memória |
| M6 — BackendAPI | `backend_api.js` | `BackendAPI.request()`, `login`, `generateSuggestions`, `chatReply`, `logEvent`, `sendFeedback`, `getSettings`, `ping`; `openAIBridge` (dev-only) |
| M7 — LearningEngine | `learning_engine.js` | Scores, templates aprendidos, feedback, filtros de desaprovadas |

---

## 2. Fluxo de Dados Principal

### 2.1 Fluxo de sugestão (caminho crítico)

```
Usuario clica "Gerar Sugestões"
  └─ gerarSugestoesPainel()              [chatplay_core.js]
       ├─ capturarMensagens()            [chat_capture.js] → lê DOM
       ├─ detectarPergunta()             [chat_capture.js] → filtra mensagens do cliente
       ├─ classificarIntencao(pergunta)  [text_analysis.js] → heurística local de palavras-chave
       ├─ buscarNoHistorico(pergunta)    [chatplay_core.js] → calcularSimilaridadeSemantica() local
       │    ├─ HIT: retorna respostas do cache local (chrome.storage)
       │    └─ MISS:
       │         └─ BackendAPI.generateSuggestions()    [backend_api.js]
       │              └─ chrome.runtime.sendMessage(BACKEND_REQUEST)
       │                   └─ handleBackendRequest()    [background.js]
       │                        ├─ chrome.storage.local → lê token
       │                        ├─ fetch POST /api/ai/suggestions
       │                        └─ (401) → fetch POST /api/auth/refresh → retry
       └─ renderizar sugestões na UI
```

### 2.2 Fluxo de chat IA

```
Usuário envia mensagem no chat interno
  └─ enviarMensagemChat()                [chatplay_core.js]
       ├─ carregarConhecimentoCoren()    [knowledge_base.js] ← ⚠️ CARREGA JSON COMPLETO (não utilizado)
       ├─ carregarConhecimentoChat()     [knowledge_base.js] ← ⚠️ CARREGA JSON COMPLETO (não utilizado)
       └─ gerarRespostaChat()            [chatplay_core.js]
            └─ BackendAPI.chatReply()   [backend_api.js]
                 └─ BACKEND_REQUEST → background.js → /api/ai/chat
```

### 2.3 Fluxo de autenticação

```
popup.js              → POST /api/auth/login   (fetch direto)
content_script.js     → BACKEND_REQUEST msg → background.js → fetch → backend
chatplay_core.js      → BACKEND_REQUEST msg → background.js → fetch → backend

background.js:
  - Injeta Authorization: Bearer <token> em toda requisição
  - Refresh automático em 401 via /api/auth/refresh
  - Persiste tokens em chrome.storage.local
  - Broadcast AUTH_UPDATED para todas as abas em /chatplay.com.br/*
```

---

## 3. Inventário de Conhecimento Local

### 3.1 Base de conhecimento carregada no client

| Recurso | URL | Momento de carga | Uso |
|---|---|---|---|
| `base_coren.json` | `https://raw.githubusercontent.com/clebermitho/knowledge-base/main/base_coren.json` | A cada `enviarMensagemChat()` (com cache em memória) | ❌ **Não é passado ao backend** — carregado mas não usado |
| `programação ia.json` | `https://raw.githubusercontent.com/clebermitho/knowledge-base/main/programa%C3%A7%C3%A3o%20ia.json` | A cada `enviarMensagemChat()` (com cache em memória) | ❌ **Não é passado ao backend** — carregado mas não usado |

**Problema crítico:** Os dois JSONs são carregados via `fetch` de URL raw do GitHub, armazenados em variáveis de módulo (`_cacheCoren`, `_cacheChat`), e **nunca são passados para `gerarRespostaChat()` ou `BackendAPI.chatReply()`**. É código morto que desperdiça memória e network.

### 3.2 Estado persistido em `chrome.storage.local`

| Chave | Conteúdo | Tamanho potencial |
|---|---|---|
| `historico_ai_v7` | Array de perguntas + respostas + tokens (até 1000 entradas) | Alto — cada entrada contém contexto (500 chars) + respostas |
| `log_sugestoes_v7` | Mapa de categoria → array de sugestões (até 500/categoria) | Moderado |
| `templates_ia_v7` | Templates aprendidos por categoria (até 20/categoria) | Baixo |
| `sugestoes_desaprovadas_v7` | Respostas rejeitadas + padrões (até 500 + 100 padrões) | Moderado |
| `scores_respostas_v7` | Map de resposta → `{acertos, erros, ultimoUso}` (até 500) | Moderado |
| `chat_messages_v7` | Últimas 200 mensagens do chat interno | Moderado |
| `estatisticas_v7` | Contadores e métricas agregadas | Baixo |
| `backend_token_v1` | JWT de acesso | Baixo |
| `backend_refresh_token_v1` | Token de refresh | Baixo |
| `chatplay_backend_url` | URL customizada do backend | Baixo |

**Risco de crescimento:** `historico_ai_v7` pode acumular dados sensíveis (conversas de atendimento). O limite de 1000 entradas está implementado, mas o conteúdo não tem TTL automático.

---

## 4. Inventário de Contratos Consumidos pela Extensão

### 4.1 Endpoints utilizados

| Método | Endpoint | Quem chama | Payload (request) | Payload (response esperado) |
|---|---|---|---|---|
| `POST` | `/api/auth/login` | `popup.js`, `content_script.js` (janela flutuante) | `{ email, password }` ou `{ username, password }` | `{ token, refreshToken, expiresAt, user }` |
| `POST` | `/api/auth/refresh` | `background.js` (automático em 401) | `{ refreshToken }` | `{ token, expiresAt }` |
| `GET` | `/api/auth/me` | `popup.js`, `chatplay_core.js` | — | `{ user: { email, name, role, organizationId }, expiresAt }` |
| `POST` | `/api/auth/logout` | `popup.js` | — | — |
| `POST` | `/api/auth/heartbeat` | `background.js` (alarm, 5 min) | — | — |
| `POST` | `/api/ai/suggestions` | `chatplay_core.js` via `BackendAPI.generateSuggestions()` | `{ context, question, category, topExamples[], avoidPatterns[] }` | `{ suggestions: [{ id, text }], latencyMs }` |
| `POST` | `/api/ai/chat` | `chatplay_core.js` via `BackendAPI.chatReply()` | `{ message, history[], context }` | `{ reply }` |
| `POST` | `/api/events` | `chatplay_core.js` via `BackendAPI.logEvent()` (fire-and-forget) | `{ eventType, payload }` | — |
| `POST` | `/api/feedback` | `chatplay_core.js` via `BackendAPI.sendFeedback()` | `{ suggestionId, type, reason? }` | — |
| `GET` | `/api/settings` | `chatplay_core.js` via `BackendAPI.getSettings()` | — | `{ settings: { key: value } }` |
| `GET` | `/api/metrics/summary` | `popup.js` | `?since=<ISO>` | `{ suggestions: { total } }` |
| `GET` | `/api/templates` | `popup.js` | — | `{ templates: [] }` |
| `GET` | `/api/feedback/rejected` | `popup.js` | — | `{ rejected: [] }` |
| `GET` | `/health` | `popup.js` (ping), `background.js` (heartbeat) | — | HTTP 200 |

### 4.2 Autenticação

- **Mecanismo:** Bearer JWT via header `Authorization: Bearer <token>`
- **Refresh:** Automático em `background.js` ao receber HTTP 401; usa `refreshToken` do storage
- **Expiração:** Controlada por `expiresAt` (ISO string); verificação local no popup antes de validar com backend
- **Armazenamento:** `chrome.storage.local` — tokens não expostos ao JavaScript da página via `window` ou `localStorage`

### 4.3 Tratamento de erros atual

| Situação | Comportamento |
|---|---|
| 401 (token expirado) | `background.js` tenta refresh; se falhar, propaga erro. `chatplay_core.js` e `popup.js` limpam token e solicitam relogin |
| 403 (sem permissão) | `chatplay_core.js` limpa token e exibe notificação de sessão expirada |
| 503 (banco offline) | `chatplay_core.js` detecta via mensagem e mantém modo degradado (dados locais) |
| Rede offline | `BackendAPI.request()` propaga o erro; chamador exibe notificação genérica de erro |
| Timeout | **Não implementado** — sem `AbortSignal.timeout()` nas chamadas do backend (somente no ping do popup) |

### 4.4 Versionamento de API

- **Status atual:** Nenhum versionamento explícito — todos os paths são `/api/*` sem `/v1/` ou header de versão
- **Risco:** Qualquer breaking change no backend quebra a extensão sem possibilidade de coexistência de versões

---

## 5. Análise das Heurísticas Atuais

### 5.1 Classificação de intenção (`classificarIntencao`)

**Localização:** `src/modules/text_analysis.js`, linha 85

**Mecanismo:**
1. Normaliza o texto (lowercase, remove acentos e pontuação, trim)
2. Para cada categoria, soma pesos se a string normalizada **contém** alguma palavra-chave (substring match)
3. Aplica penalidade de 20% nos scores se o texto contém "não", "nunca" ou "jamais"
4. Retorna a categoria de maior score; retorna `"OUTROS"` se nenhuma categoria acertou

**Categorias e pesos:**

| Categoria | Peso | Palavras-chave (exemplos) |
|---|---|---|
| `SUSPENSAO` | 1.5 | "suspens", "suspende", "paralisar", "interromper", "pausar", "baixa temporária" |
| `CANCELAMENTO` | 1.5 | "cancel", "cancela", "encerrar", "terminar", "desistir", "anular", "excluir" |
| `NADA_CONSTA` | 2.0 | "nada consta", "não consta", "sem registro", "não encontrado", "inexistente" |
| `GOLPE` | 2.0 | "golpe", "fraude", "enganaram", "problema", "suspeito", "estelionato" |
| `PRAZO` | 1.2 | "prazo", "tempo", "demora", "quanto tempo", "previsão", "quando", "data limite" |
| `NEGOCIACAO` | 1.3 | "parcel", "negoci", "acordo", "divid", "débito", "dev", "anuidade", "regularizar", "pagamento" |
| `SEM_DINHEIRO` | 1.3 | "dinheiro", "pagar", "sem condi", "caro", "valor alto", "difícil", "apertado" |
| `DUVIDA` | 1.0 | "dúvida", "esclarec", "entender", "como funciona", "explicar", "significa" |
| `RECLAMACAO` | 1.2 | "reclam", "problema", "erro", "não funciona", "ruim", "péssimo", "insatisfeito" |

**Limitações identificadas:**

| Limitação | Exemplo de falha |
|---|---|
| **Substring frágil** | "cancelamento" acerta, mas "quero encerrar meu registro" não acerta CANCELAMENTO por falta de "cancel" |
| **Sem stemming real** | "parcelamento" acerta (contém "parcel"), mas "dividir em vezes" não acerta NEGOCIACAO |
| **Penalidade de negação simplista** | "não preciso cancelar" penaliza CANCELAMENTO em 20%, mas ainda retorna CANCELAMENTO (incorretamente) |
| **Palavras ambíguas sem desambiguação** | "problema" ativa GOLPE e RECLAMACAO simultaneamente; a categoria de maior peso ganha, sem considerar contexto |
| **Sem confiança calculada** | Não há score de confiança retornado — impossível saber quando a classificação é incerta |
| **Sem fallback controlado** | Quando retorna `"OUTROS"`, não há distinção entre "texto sem intenção clara" vs "erro de classificação" |
| **Dependência do vocabulário do domínio** | Palavras fora do léxico das 9 categorias nunca são classificadas, mesmo que o contexto seja claro |
| **Sem consideração de contexto** | Classifica apenas a pergunta isolada, sem levar em conta o histórico de conversa |

**Baseline conceitual de acurácia (sem dataset formal):**
- Casos diretos (palavras-chave explícitas): estimativa de **75–85%** de acerto
- Casos com paráfrase ou variação linguística: estimativa de **40–60%** de acerto
- Textos curtos (<5 tokens): alto risco de retornar `"OUTROS"` incorretamente

### 5.2 Similaridade semântica (`calcularSimilaridadeSemantica`)

**Localização:** `src/modules/text_analysis.js`, linha 53

**Mecanismo:**
1. Tokeniza texto A com pesos TF-IDF simples (frequência no documento × IDF calculado sobre `AppState.historico`)
2. Tokeniza texto B sem pesos
3. Calcula score de interseção ponderada: `score += peso_A[token] × bonus_comprimento` se token está em B
4. Normaliza pelo peso total de A
5. **Bônus de 0.2** se ambos os textos têm a mesma categoria classificada por `classificarIntencao()`
6. Retorna valor no intervalo [0, 1]

**Threshold de uso:** `CONFIG.SIMILARITY_THRESHOLD = 0.65` — se a similaridade com algum item do histórico supera 0.65, reutiliza as respostas sem chamada ao backend

**Limitações identificadas:**

| Limitação | Impacto |
|---|---|
| **Bag-of-words sem semântica real** | "quero cancelar" e "desejo encerrar meu cadastro" têm similaridade ≈ 0 por não compartilharem tokens |
| **IDF calculado sobre historico local** | Com histórico vazio ou pequeno, `idf ≈ 0` para todas as palavras → pesos ineficazes |
| **Sem embeddings vetoriais** | Não há representação semântica densa — apenas contagem de tokens em comum |
| **Stopwords incompleta** | Lista hardcoded com 13 palavras; "não", "ser", "ter", "estar" não estão incluídas |
| **Bônus de categoria circular** | O bônus de 0.2 por categoria depende de `classificarIntencao()`, que por sua vez tem as limitações já descritas |
| **Sem normalização por comprimento de texto B** | Textos curtos em B sempre parecem mais similares |

**Taxa de uso do cache do histórico:** Não instrumentado — sem telemetria para medir quantas vezes o threshold 0.65 é atingido na prática.

### 5.3 Aprendizado local (`learning_engine.js`)

- Templates aprendidos a partir de respostas aprovadas (limite 20/categoria)
- Scores de acerto/erro por resposta (limite 500 entradas)
- Respostas desaprovadas com padrões de palavras-chave (limite 500 + 100 padrões)
- **Problema:** Aprendizado é local ao dispositivo e à sessão instalada; não é compartilhado entre usuários da mesma organização

---

## 6. Problemas Identificados

### 6.1 Heurísticas frágeis (prioridade crítica)

| Problema | Localização | Impacto |
|---|---|---|
| `classificarIntencao` sem confiança e sem fallback robusto | `text_analysis.js:85` | Classificação incorreta silenciosa → contexto errado enviado ao backend |
| `calcularSimilaridadeSemantica` baseada em bag-of-words | `text_analysis.js:53` | Cache do histórico mal aproveitado; perguntas parecidas são tratadas como novas |
| Threshold 0.65 hardcoded sem instrumentação | `config.js:21` | Sem dados para calibrar o threshold com base em uso real |

### 6.2 Carregamento desnecessário de JSONs (prioridade alta)

| Problema | Localização | Impacto |
|---|---|---|
| `carregarConhecimentoCoren()` chamado em `enviarMensagemChat()` sem usar o retorno | `chatplay_core.js:394` | Desperdício de memória e network; potencial bloqueio de 100ms–2s |
| `carregarConhecimentoChat()` idem | `chatplay_core.js:395` | Idem |
| Cache em memória sem TTL | `knowledge_base.js:13-14` | JSON potencialmente obsoleto durante toda a sessão da aba |
| Fetch direto de GitHub raw (sem autenticação, sem rate limit client-side) | `config.js:23-24` | GitHub raw URLs têm rate limit; extensão pode falhar em uso intensivo |

### 6.3 Acoplamento e complexidade (prioridade média)

| Problema | Localização | Impacto |
|---|---|---|
| `chatplay_core.js` com 2260 linhas contendo M5+M7+M8+M9 co-localizados | `chatplay_core.js` | Manutenção difícil; dependências circulares UI ↔ SuggestionEngine |
| Constantes de storage duplicadas em `background.js` e `modules/config.js` | `background.js:16-21` | Risco de divergência de chaves entre contextos |
| Constantes de storage também em `popup.js` e `content_script.js` | `popup.js:19-27`, `content_script.js:156-159` | Idem — 4 cópias das mesmas chaves |
| `AppState` global mutável compartilhado sem encapsulamento | `state.js` | Dificuldade de rastrear quem altera o estado; risco de race conditions |

### 6.4 Riscos de performance e memória

| Risco | Localização | Impacto |
|---|---|---|
| `AppState.historico` pode acumular até 1000 entradas com contexto de 500 chars cada | `chatplay_core.js:302` | ≈ 500 KB em `chrome.storage.local` |
| Busca no histórico é O(n) linear sobre todas as entradas | `chatplay_core.js:309-327` | Com 1000 entradas, pode ser lento em hardware mais fraco |
| JSON da knowledge base carregado inteiro em memória | `knowledge_base.js` | Memória do service worker (efêmero, mas do content_script não) |
| Sem timeout nas chamadas ao backend (`BackendAPI.request`) | `backend_api.js:54-84` | Uma chamada travada pode bloquear a UI indefinidamente |

### 6.5 Riscos de segurança e privacidade

| Risco | Localização | Impacto | Mitigação atual |
|---|---|---|---|
| Histórico de conversas (potencialmente sensível) armazenado localmente | `chrome.storage.local` | Dados do atendimento ficam no dispositivo do operador | Limite de 1000 entradas; sem criptografia local |
| `openAIBridge` aceita `apiKey` como parâmetro | `backend_api.js:165` | Risco de uso acidental em produção com chave exposta | Comentário de aviso; nunca chamado nos fluxos de produção (verificado) |
| URLs do GitHub raw para knowledge base são públicas e sem controle de versão explícito | `config.js:23-24` | Qualquer mudança no arquivo quebra silenciosamente o comportamento | Cache em memória mascara o problema por sessão |
| Dados de conversas no `contexto` enviado ao backend (POST /api/ai/chat) | `chatplay_core.js:204-208` | PII de clientes trafega para o backend | Depende de política de privacidade e segurança do backend |

---

## 7. Baseline Conceitual de Qualidade

Estas métricas **não têm valores medidos** no estado atual (ausência de instrumentação formal). São definidas aqui para servir como guia para a Fase 4 (implementação).

| Métrica | Definição | Método de coleta atual | Meta alvo |
|---|---|---|---|
| **Acerto de intenção** | % de perguntas classificadas corretamente em relação a um label humano | ❌ Não coletado | ≥ 90% (com fallback para OUTROS honesto) |
| **Precisão top-k** | % de respostas geradas pelo backend que o operador usa (aprova) | `BackendAPI.sendFeedback()` registra aprovação, mas sem denominador claro | ≥ 70% de aprovação nas sugestões exibidas |
| **Taxa de fallback** | % de classificações que retornam `"OUTROS"` | ❌ Não coletado | < 10% nos fluxos de atendimento normais |
| **Latência percebida** | Tempo entre clique em "Gerar Sugestões" e exibição das respostas | ❌ Não medido no client | < 2s (P95) |
| **Taxa de cache hit** | % de perguntas resolvidas pelo histórico local (sem backend call) | `AppState.estatisticas.totalEconomiaAPI` incrementado, mas sem denominador | > 20% após período de aquecimento |

---

## 8. Resumo dos Riscos

| Risco | Probabilidade | Impacto | Prioridade |
|---|---|---|---|
| Heurística de intenção retorna categoria errada silenciosamente | Alta | Alto (resposta inadequada ao cliente) | 🔴 Crítico |
| JSONs da knowledge base carregados mas nunca usados | Confirmado | Médio (desperdício + confusão futura) | 🔴 Crítico |
| Sem timeout nas chamadas de backend | Alta | Alto (UI pode travar) | 🟠 Alto |
| Histórico local com dados sensíveis sem TTL/criptografia | Médio | Alto (privacidade) | 🟠 Alto |
| Chaves de storage duplicadas em 4 arquivos | Alta | Médio (bug de manutenção) | 🟡 Médio |
| Threshold de similaridade 0.65 sem validação empírica | Alta | Médio (cache usado incorretamente) | 🟡 Médio |
| `chatplay_core.js` monolítico (2260 linhas) | Confirmado | Médio (manutenibilidade) | 🟡 Médio |
| API sem versionamento (`/api/*` sem `/v1/`) | Confirmado | Médio (breaking change em atualização de backend) | 🟡 Médio |

---

## 9. Comandos de Diagnóstico Executados

```bash
# Mapeamento de módulos e linhas
wc -l src/*.js src/modules/*.js popup.js
# → chatplay_core.js: 2260 linhas

# Verificar uso de carregarConhecimento nas chamadas reais
grep -n "carregarConhecimento" src/chatplay_core.js src/modules/knowledge_base.js
# → Confirmado: chamado em enviarMensagemChat(), retorno nunca passado para gerarRespostaChat()

# Verificar duplicação de STORAGE_KEYS
grep -rn "backend_token_v1\|BACKEND_TOKEN" src/ popup.js
# → Confirmado: 4 arquivos com a mesma string literal

# Verificar chamadas com timeout
grep -rn "AbortSignal\|timeout" src/ popup.js
# → Apenas popup.js/pingBackend() tem AbortSignal.timeout(3000)

# Verificar versionamento de API
grep -rn '"/api/' src/modules/backend_api.js popup.js
# → Todos os paths são /api/* sem /v1/
```

---

## 10. Pendências com Prioridade

| ID | Pendência | Prioridade | Fase alvo |
|---|---|---|---|
| P0-01 | Remover ou conectar o carregamento dos JSONs de knowledge base (dead code ou migrar para API) | 🔴 Crítico | Fase 1/4 |
| P0-02 | Adicionar confiança ao retorno de `classificarIntencao` para habilitar fallback controlado | 🔴 Crítico | Fase 4 |
| P0-03 | Adicionar timeout (`AbortSignal.timeout`) em todas as chamadas `BackendAPI.request()` | 🟠 Alto | Fase 4 |
| P0-04 | Centralizar `STORAGE_KEYS` em um único arquivo importado por todos os contextos | 🟡 Médio | Fase 4 |
| P0-05 | Definir TTL e política de invalidação para o cache de knowledge base | 🟡 Médio | Fase 1/4 |
| P0-06 | Instrumentar taxa de cache hit, taxa de fallback e latência de sugestões | 🟡 Médio | Fase 4 |
| P0-07 | Adicionar versionamento `/v1/` nos contratos da API | 🟡 Médio | Coordenar com backend |
| P0-08 | Quebrar `chatplay_core.js` em módulos M5/M7/M8/M9 separados (Fase D da migração) | 🟢 Baixo | Fase 4 |
