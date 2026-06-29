# Auto-Protocolar — SIGAD / ESAJ

Automação do fluxo de protocolo de documentos periciais: confere documentos no SIGAD, peticiona no ESAJ e encaminha o serviço.

---

## 1. Fluxograma

```
[INÍCIO]
node src/web/auto-protocolar.js
│
├─ [1. Login ESAJ] ───────────────── certificado digital             ✔
├─ [2. Login SIGAD] ──────────────── sessão ativa ou auth.js         ✔
├─ [3. Listar serviços] ──────────── pending.json (retomável)        ✔
│
│ ╔══════════════════════════════════════════════════════════════════╗
│ ║  LOOP por serviço em pending.json                                ║
│ ║                                                                  ║
│ ║  [Etapa 2]  Aba Fases ─────────────────────────────────── ✔     ║
│ ║      Extrai Fase, Subfase, Observação                            ║
│ ║      Observação = docs esperados (separados por //)              ║
│ ║      Sem fases → pula serviço                                    ║
│ ║                                                                  ║
│ ║  [Etapa 3]  Aba Documentos ───────────────────────────── ✔      ║
│ ║      Extrai 1 ou 2 docs mais recentes (2 se há Alvará)           ║
│ ║      Não confere com Observação da Fase → pula serviço           ║
│ ║                                                                  ║
│ ║  [Etapa 4]  Dados Básicos → abre ESAJ em nova aba ──────── ✔    ║
│ ║      Retry ×3 se reCAPTCHA (#linkPasta ausente)                  ║
│ ║                                                                  ║
│ ║  [Etapa 5]  Localizar pasta no servidor ───────────────── ✔     ║
│ ║      TRABALHOS_FINAIS/<servico>/<subpasta_mais_recente>/         ║
│ ║      Extrai cabeçalho da 1ª pág do PDF:                          ║
│ ║      vara, foro, n° processo, classe, reqte (autor), reqdo (réu) ║
│ ║                                                                  ║
│ ║  [Etapa 6]  Extrair partes + cabeçalho do ESAJ ────────── ✔     ║
│ ║      (paralelo) Autor + Réu; "E OUTROS" se tableTodasPartes      ║
│ ║      Cabeçalho: classe, foro, vara, n° processo — tudo maiúsculo ║
│ ║                                                                  ║
│ ║  [Etapa 7]  Conferir doc × ESAJ ──────────────────────── ✔      ║
│ ║      Compara: vara, foro, processo, classe, autor, réu           ║
│ ║      Divergência → notificação e-mail ⚙ pendente → pula         ║
│ ║                                                                  ║
│ ║  ┌─── Loop Peticionar (1× normal · 2× se Alvará) ─────────────┐ ║
│ ║  │  [Etapa 8]  Abrir formulário de petição ─────────── ✔       │ ║
│ ║  │  [Etapa 9]  Importar documento PDF ──────────────── ✔       │ ║
│ ║  │  [Etapa 9]  Preencher dados da petição ──────────── ✔       │ ║
│ ║  │      Peticionante: ÉRIKA PINTO NOGUEIRA                     │ ║
│ ║  │      Classificação: código por Fase/Subfase (ver tabela)     │ ║
│ ║  │      Solicitante: Vinicius Coutinho (01.088.089/0001-52)     │ ║
│ ║  │  [Etapa 10] Salvar para protocolar depois ─────────── ✔     │ ║
│ ║  │      (Alvará: reabre ESAJ pela Etapa 4, código 38380)        │ ║
│ ║  └──────────────────────────────────────────────────────────────┘ ║
│ ║                                                                  ║
│ ║  [Etapa 11] Encaminhar no SIGAD ──────────────────────── ✔      ║
│ ║      Editar → aba Fases → Encaminhar                            ║
│ ║      Nome: Dayane Franco Alves                                   ║
│ ║      Subfase: AGUARDAR PROTOCOLO                                 ║
│ ║      Observação: mesma da Fase                                   ║
│ ║      Salvar Fase → Salvar Detalhes                               ║
│ ║                                                                  ║
│ ╚══════════════════════════════════════════════════════════════════╝
│
└─ [Limpeza] ─────────────── pending.json removido ao final do loop  ✔

[FIM]
```

**Tabela de Classificação (Etapa 9):**

| Fase | Subfase | Código | Descrição |
|------|---------|--------|-----------|
| Qualquer | `PROTOCOLAR-PRAZO` | 38423 | Dilação de prazo |
| Qualquer | `PROTOCOLAR-*` (exceto prazo) | 8822 | Manifestação do perito |
| Laudo / Esclarecimento | `PROTOCOLAR` | 38368 | Laudo |
| Outros | `PROTOCOLAR` | 8822 | Manifestação do perito |
| — | Alvará (2° doc) | 38380 | Pedido de expedição de alvará |

**Legenda:** `✔` implementado · `⚙ pendente` não iniciado

**Retomada parcial:** `node src/web/auto-protocolar.js etapa11` lê `data/extracao-protocolo.json` e executa apenas o Encaminhar.

---

## 2. Scripts

| Script | Responsabilidade |
|--------|-----------------|
| `src/web/auto-protocolar.js` | Fluxo principal: Fases, Documentos, ESAJ, Peticionar, Encaminhar |
| `src/web/auth.js` | Login no SIGAD, salva cookies em `data/auth.json` |
| `src/web/crawler.js` | Filtra tabela, extrai todas as páginas → `data/resultados.json` |
| `src/web/recorder.js` | Grava interações na guia de processo para mapear seletores |
| `src/server/sincronizador.js` | Upload SFTP ao servidor (stub) |

---

## 3. Fluxos Detalhados

### 3.1 Login e Sessão (`auth.js` + `crawler.js`)

- `auth.js`: lê `SIGAD_USUARIO` / `SIGAD_SENHA` do `.env`, preenche o formulário de login e salva cookies em `data/auth.json`.
- `auto-protocolar.js` detecta sessão SIGAD ativa pela presença de `"Painéis"` no menu; refaz o login automaticamente se expirou.
- `abrirBrowser()` em `crawler.js` — abre o Chromium reutilizando o perfil em `data/chrome-profile` (mantém cookies e sessões).

**Workaround técnico:** PrimeFaces mantém conexões keepalive que bloqueiam `networkidle`. `aguardarAjax()` espera `PrimeFaces.ajax.Queue.isEmpty()` antes de prosseguir.

---

### 3.2 Etapa 2 — Fases

Clica na aba Fases do dialog `formDlgVerServico`. Lê a primeira linha de `tabListaFase_data`: Fase, Subfase, Observação. A Observação contém os nomes dos documentos esperados separados por ` // ` (doc2 = sempre Alvará).

---

### 3.3 Etapa 3 — Documentos

Clica na aba Documentos. Extrai 1 ou 2 documentos mais recentes. Confere se os nomes batem (lowercase `includes`) com os da Observação — caso contrário encerra o serviço com log de aviso.

---

### 3.4 Etapa 4 — Dados Básicos → ESAJ

Clica na aba Dados Básicos e localiza o span com o n° de processo (`/\d{7}-\d{2}\.\d{4}/`). Clica para abrir nova aba ESAJ. Retry ×3 aguardando `#linkPasta` aparecer. Se a sessão ESAJ expirou, `loginEsaj` re-autentica via certificado.

---

### 3.5 Etapa 5 — Servidor (Trabalhos Finais)

- Lê `TRABALHOS_FINAIS` do `.env`.
- Abre `<TRABALHOS_FINAIS>/<numero_servico>/` e seleciona a subpasta mais recente (por `mtime`).
- Usa `pdf-parse` para ler apenas a 1ª página do PDF e extrair via regex: `vara`, `foro`, `processo`, `classe`, `reqte`, `reqdo`.

---

### 3.6 Etapa 6 — Partes + Cabeçalho do ESAJ (paralelo)

- **`extrairPartesDoESAJ`**: lê `#tablePartesPrincipais` e `#tableTodasPartes`. Classifica label → AUTOR/RÉU via `classificarRoleESAJ`. Adiciona ` E OUTROS` se `tableTodasPartes` tiver mais de uma ocorrência do papel.
- **`extrairCabecalhoDoESAJ`**: lê `#classeProcesso`, `#foroProcesso`, `#varaProcesso` (fallback via `th` label). Tudo em maiúsculo.

---

### 3.7 Etapa 7 — Conferência doc × ESAJ

`normalizar()` remove acentos, pontuação, ordinais com zero (`02ª` → `2ª`), sufixos de estado (`/MS.`) e barras. Compara campo a campo: vara, foro, processo, classe, autor, réu. Leniência para `"E OUTROS"` nos nomes. Divergência encerra o serviço (notificação por e-mail pendente).

---

### 3.8 Etapas 8-10 — Peticionamento no ESAJ

**Loop `peticionarNoESAJ`:** 1 iteração normal; 2 se `temAlvara`. Na 2ª, retorna ao SIGAD e reabre o processo via Etapa 4.

**Etapa 8 — Abrir formulário:** `#dropdownCriarPeticaoInicial` → `#linkPeticionar`. Aguarda `[aria-label="Adicionar arquivos elaborados"]`.

**Etapa 9 — Importar documento:** `waitForEvent('filechooser')` + `setFiles(filePath)`. Aguarda 3s para processamento.

**Etapa 9 — Preencher dados:**
1. **Peticionante** — digita "ÉRIKA", seleciona `ÉRIKA PINTO NOGUEIRA - Advogado(a)`. Remove tag anterior se existir.
2. **Classificação** — rejeita sugestão incorreta → busca pelo código via `#selectClasseIntermediaria`. Aceita sugestão se código bater.
3. **Solicitante** — se CNPJ `01.088.089/0001-52` já está nas partes clica em `botao-incluir-polo`; caso contrário adiciona por formulário (tipo Jurídica + CNPJ).

**Etapa 10 — Salvar:** `#botaoSalvarPeticaoParaProtocolar` → aguarda `networkidle` → fecha aba.

---

### 3.9 Etapa 11 — Encaminhar no SIGAD

1. Clica em **Editar** no dialog → formulário abre em `formServico` (IDs com fallback).
2. Clica na aba **Fases**.
3. Clica em **Encaminhar** → dialog `formDlgEnviarServico`.
4. Preenche Nome via autocomplete (`pressSequentially` + seleciona 1° resultado).
5. Seleciona Subfase: `AGUARDAR PROTOCOLO`.
6. Preenche Observação (triple-click + `fill`).
7. **Salvar Fase** → **Salvar Detalhes**.

**Retomada isolada:** `node src/web/auto-protocolar.js etapa11` lê `data/extracao-protocolo.json`, abre o dialog do serviço, navega para Dados Básicos e chama `encaminharServico` diretamente.

---

### 3.10 Recorder (`recorder.js`)

Utilitário de desenvolvimento para mapear seletores JSF/PrimeFaces:
- `prepararPagina()` — abre o SIGAD já logado com filtro `Cadastro`.
- Injeta spy JS (`click`, `change`, `input`) na aba ESAJ; re-injeta após `framenavigated`.
- Após 10s de inatividade, salva em `data/recording.json` e fecha.

---

## 4. Stubs Pendentes

| Módulo | Status | Pendência |
|--------|--------|-----------|
| `src/server/sincronizador.js` | ⚙ stub | Credenciais SSH/SFTP |
| Notificação de divergência (Etapa 7.2) | ⚙ stub | `GMAIL_USUARIO`/`GMAIL_APP_PASSWORD` no `.env` |

---

## 5. Arquivos em `data/`

| Arquivo | Gerado por | Conteúdo |
|---------|-----------|----------|
| `auth.json` | `auth.js` | Cookies de sessão do SIGAD (mantido entre execuções) |
| `pending.json` | `auto-protocolar.js` | Serviços não processados; deletado ao final do loop |
| `extracao-protocolo.json` | `auto-protocolar.js` | Estado acumulado por serviço; preservado para retomada via `etapa11` |
| `recording.json` | `recorder.js` | Interações + navegações gravadas na guia ESAJ |

---

## 6. IDs PrimeFaces Confirmados (deploy atual)

**Tabela SIGAD (`crawler.js`):**
- Filtro Situação: `formServico:tabela:j_idt381_label` / `j_idt381_panel`
- Coluna Teor da Intimação: `formServico:tabela:j_idt373`
- Coluna Disponibilização: `formServico:tabela:j_idt357`
- Coluna Processo (link ESAJ): `formServico:tabela:j_idt331` ou `j_idt367`

**Dialog do serviço — Etapas 2-4:**
- Abas: `formDlgVerServico:tabViewEvento` → `a:has-text("Fases" | "Documentos" | "Dados Básicos")`
- Tabela fases: `formDlgVerServico:tabViewEvento:tabListaFase_data`
- Tabela documentos: `formDlgVerServico:tabViewEvento:tabListaDocumento_data`

**Etapa 11 — Encaminhar (com fallbacks):**
- Botão Editar: `[id="formDlgVerServico"] span.ui-button-text:has-text("Editar")`
- Aba Fases pós-Editar: `j_idt474` → fallback `j_idt436`
- Botão Encaminhar: `j_idt474:j_idt545` → fallback `j_idt436:j_idt507`
- Autocomplete Nome: `formDlgEnviarServico:inputUsuario_input`
- Subfase: `formDlgEnviarServico:inputSubfase_label` / `inputSubfase_panel`
- Observação: `formDlgEnviarServico:inputObsFase`
- Salvar Fase: `formDlgEnviarServico:j_idt750` → fallback `j_idt712`
- Salvar Detalhes: `formServico:j_idt471` → fallback `j_idt433`

> IDs `j_idt*` podem mudar entre deploys do SIGAD. Os seletores usam CSS com vírgula (`[id="A"], [id="B"]`) — o Playwright resolve o primeiro presente no DOM.

---

## 7. Problemas Conhecidos

- **IDs dinâmicos JSF:** mudam entre deploys. Manter fallbacks no objeto `SEL` de `auto-protocolar.js`.
- **reCAPTCHA no ESAJ:** retry ×3 (2s entre tentativas). Após 3 falhas, o serviço é pulado.
- **Timeout AJAX:** a fila PrimeFaces pode não esvaziar em 15s em conexões lentas.
- **Notificação de divergência (Etapa 7.2):** código comentado — requer `GMAIL_USUARIO`/`GMAIL_APP_PASSWORD`.

---

## 8. Instalação e Execução

**Pré-requisito:** Node.js ≥ 18

```bash
npm install
npx playwright install chromium
```

**`.env` na raiz:**
```env
SIGAD_USUARIO=seu_usuario
SIGAD_SENHA=sua_senha
TRABALHOS_FINAIS=\\servidor\Trabalhos Finais
# GMAIL_USUARIO=
# GMAIL_APP_PASSWORD=
```

**Comandos:**
```bash
# Fluxo completo (Etapas 2-11)
node src/web/auto-protocolar.js
npm run protocolar

# Só Encaminhar — retomada após falha na Etapa 11
node src/web/auto-protocolar.js etapa11

# Gravador de interações (desenvolvimento — mapear seletores)
node src/web/recorder.js
npm run recorder
```

---

## 9. Prefixos de Log

| Prefixo | Origem |
|---------|--------|
| `[auth]` | `src/web/auth.js` |
| `[crawler]` | `src/web/crawler.js` |
| `[auto-protocolar]` | `src/web/auto-protocolar.js` — loop principal |
| `[etapa-2]` … `[etapa-11]` | `src/web/auto-protocolar.js` — etapas individuais |
| `[peticionar]` | `src/web/auto-protocolar.js` — loop de peticionamento |
| `[esaj]` | `src/web/auto-protocolar.js` — login ESAJ |
| `[recorder]` | `src/web/recorder.js` |
| `[sincronizador]` | `src/server/sincronizador.js` |
