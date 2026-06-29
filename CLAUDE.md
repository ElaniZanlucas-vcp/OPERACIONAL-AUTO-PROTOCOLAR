# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Fluxo completo (Etapas 2-11)
node src/web/auto-protocolar.js

# Só Encaminhar — retomada após falha na Etapa 11
node src/web/auto-protocolar.js etapa11

# Gravador de interações na guia ESAJ (desenvolvimento — mapear seletores)
node src/web/recorder.js
```

Não há suite de testes nem linter configurados neste projeto.

## Arquitetura

### Script principal

**`auto-protocolar.js`** executa as etapas 2-11 por serviço:
- Etapas 2-4: lê Fases, Documentos e Dados Básicos do SIGAD; abre processo no ESAJ.
- Etapas 5-7: extrai cabeçalho do PDF no servidor; extrai partes + cabeçalho do ESAJ; confere os dois.
- Etapas 8-10: peticiona documento(s) no ESAJ (loop duplo se há Alvará).
- Etapa 11: encaminha no SIGAD (Editar → Fases → Encaminhar → Salvar).
- Modo `etapa11`: retomada isolada a partir de `data/extracao-protocolo.json`.

### Fluxo web (Playwright / PrimeFaces)

O SIGAD usa JSF + PrimeFaces. Regras que afetam todos os scripts:

1. **`aguardarAjax(page)`** — deve ser chamado após qualquer interação; espera `PrimeFaces.ajax.Queue.isEmpty()` pois keepalives bloqueiam `networkidle` indefinidamente.
2. **IDs dinâmicos** — formato `formServico:tabela:j_idt345`. Estáveis por sessão, mas podem mudar entre deploys. Seletores usam `[id="..."]`, nunca CSS com `:`. Manter fallbacks no objeto `SEL` de `auto-protocolar.js`.
3. **`prepararPagina()`** em `crawler.js` — retorna `{ browser, context, page }` já logado e com filtro `Situação = Cadastro`. Ponto de entrada correto para `recorder.js`.
4. **`pressSequentially()` em vez de `fill()`** — campos `p:autoComplete` precisam de `keydown`/`keyup` para disparar busca AJAX. Sempre `locator.click()` + `locator.pressSequentially(texto, { delay: 80 })`.
5. **Scoping em formulários** — escopar em `[id="formServico"]` para evitar match em elementos homônimos dentro de `formDlgVerServico` (oculto mas presente no DOM).
6. **Triple-click antes de `pressSequentially()`** — PrimeFaces preserva estado de inputs entre aberturas de dialog. Usar `click({ clickCount: 3 })` para selecionar-e-sobrescrever.
7. **`li:not(.ui-autocomplete-empty-message)`** — para verificar resultados reais no painel autocomplete.

### ESAJ (e-SAJ TJMS)

- Formato do n° de processo: `1111111-11.1111.8.12.0000`
  - `#numeroDigitoAnoUnificado` ← `1111111-11.1111`
  - `#foroNumeroUnificado` ← `0000`
- Botão Consultar: `#botaoConsultarProcesso` (fallback: `input[value="Consultar"]`)
- Link "Visualizar autos": `#linkPasta`
- **reCAPTCHA:** `#linkPasta` não aparece; retry ×3 (2s entre tentativas).
- **Sessão expirada:** detectada via URL (`sajcas`/`/login`); `loginEsaj` re-autentica por certificado.

### Fluxo auto-protocolar.js — detalhes críticos

**Contexto dialog vs. formulário de edição:**
- Etapas 2-4 operam dentro de `formDlgVerServico` (dialog de visualização).
- Após **Editar** (Etapa 11), o dialog fecha e o formulário abre em `formServico`. As abas e botões da Etapa 11 têm IDs distintos — com fallbacks no `SEL`.

**Fallback de IDs (Etapa 11):**
Os IDs mudaram entre deploys (`j_idt474:j_idt545` → `j_idt436:j_idt507`). Padrão:
```javascript
'[id="formServico:j_idt474"] a:has-text("Fases"), [id="formServico:j_idt436"] a:has-text("Fases")'
```
O Playwright resolve o primeiro presente no DOM.

**Conferência (Etapa 7):**
`normalizar()` remove acentos, pontuação, ordinais com zero (`02ª` → `2ª`), sufixos de estado (`/MS.`) e barras. Leniência para `"E OUTROS"` nos nomes de partes.

**Loop de peticionamento (Etapas 8-10):**
- Documento principal sempre primeiro (código por Fase/Subfase).
- Se `temAlvara`: após salvar o doc principal, retorna ao SIGAD (`page.bringToFront()`), reabre o processo via Etapa 4 para nova aba ESAJ e repete com código 38380.

**Modo etapa11:**
Lê `data/extracao-protocolo.json` → extrai `servico` e `fases.observacao` → clica no serviço na tabela → navega para aba Dados Básicos → chama `encaminharServico`.

### IDs PrimeFaces confirmados (deploy atual)

**Tabela SIGAD (`crawler.js`):**
- Filtro Situação label/panel: `formServico:tabela:j_idt381_label` / `j_idt381_panel`
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

### Controle de estado em runtime

- `data/auth.json` — cookies da sessão; reutilizado entre execuções para evitar login repetido.
- `data/pending.json` — lista de serviços não processados; deletado no bloco `finally` ao fim do loop.
- `data/extracao-protocolo.json` — estado acumulado por serviço; atualizado após cada etapa via `salvarExtracao()`; preservado para retomada via `etapa11`.

### Stubs pendentes

- `src/server/sincronizador.js` — interface definida (`enviarArquivo`); credenciais SSH pendentes.
- Notificação de divergência (Etapa 7.2) — código comentado em `auto-protocolar.js`; requer `GMAIL_USUARIO`/`GMAIL_APP_PASSWORD` no `.env`.

## Credenciais

Arquivo `.env` na raiz (não versionado):
```
SIGAD_USUARIO=
SIGAD_SENHA=
TRABALHOS_FINAIS=
# GMAIL_USUARIO=
# GMAIL_APP_PASSWORD=
```
