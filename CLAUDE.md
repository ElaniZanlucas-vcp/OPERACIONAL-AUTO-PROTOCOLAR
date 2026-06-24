# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Fase PRE — login + extração (sem IA)
node main.js pre

# Loop completo standalone (skills ativas)
node src/web/api-site.js

# Gravador de interações na guia ESAJ (desenvolvimento — mapear seletores)
node src/web/recorder.js

# Python (quando manipulador_word.py for ativado)
.venv\Scripts\python src/local/manipulador_word.py <template.docx> <output.docx>
```

Não há suite de testes nem linter configurados neste projeto.

## Arquitetura

### Separação IA × Script

O orquestrador `main.js` divide o fluxo em duas fases para minimizar consumo de tokens:

- **Fase `pre`**: scripts puros (Playwright) — login e extração → `data/resultados.json`
- **Fase `post`**: recebe um item JSON enriquecido pela skill e executa os passos finais para aquele item

A IA (Claude Code) só entra nos **Passos 5 e 6** por item (skills de tipo e honorários). Todo o resto é Playwright/Node.

### Skills

Três skills em `.claudeskills/`:

- **`processar-dados`** — skill de orquestração: instrui Claude Code a rodar fase PRE, depois iterar `resultados.json` acionando as skills por item e então a fase POST.
- **`skill-tipo-pericia`** — classifica o processo em um dos ~70 tipos de perícia da lista fechada em `tipo_pericia.md` (9 grupos). Anti-alucinação por escopo fechado.
- **`skill-proposta-honorarios`** — calcula faixa de honorários com base no tipo de perícia e na `matriz_honorarios.md`. Retorna JSON com natureza, unidade, quantidade, faixa e valores mínimo/máximo.

### Fluxo web (Playwright / PrimeFaces)

O SIGAD usa JSF + PrimeFaces. Particularidades que afetam todos os scripts web:

1. **`aguardarAjax(page)`** — deve ser chamado após qualquer interação; espera `PrimeFaces.ajax.Queue.isEmpty()` antes de `networkidle`, pois keepalives do PF bloqueiam o estado `networkidle` indefinidamente.
2. **IDs dinâmicos** — o PrimeFaces gera IDs no formato `formServico:tabela:j_idt345`. São estáveis entre sessões mas podem mudar entre deploys. Os seletores usam `[id="..."]` ou XPath, nunca CSS com `:`.
3. **`prepararPagina()`** em `crawler.js` — função reutilizável que retorna `{ browser, context, page }` já logado e com o filtro `Situação = Cadastro` aplicado. É o ponto de entrada correto para qualquer script que precise da tabela.
4. **`pressSequentially()` em vez de `fill()`** — campos `p:autoComplete` do PrimeFaces precisam de eventos `keydown`/`keyup` para disparar a busca AJAX. Usar `fill()` seta o valor diretamente sem acionar o autocomplete. Sempre usar `locator.click()` seguido de `locator.pressSequentially(texto, { delay: 80 })` nesses campos.
5. **Scoping em formulários** — ao localizar abas ou botões, sempre escopar em `[id="formServico"]` para evitar match em elementos homônimos dentro do dialog `formDlgVerServico` (que fica oculto mas presente no DOM).
6. **Triple-click antes de `pressSequentially()`** — PrimeFaces preserva o estado de inputs entre abertura/fechamento de dialogs. Usar `click({ clickCount: 3 })` antes de digitar para selecionar-e-sobrescrever o conteúdo anterior.
7. **`li:not(.ui-autocomplete-empty-message)`** — para verificar resultados reais no painel autocomplete; `li.ui-autocomplete-empty-message` indica "sem resultados".

### ESAJ (e-SAJ TJMS)

O SIGAD abre o processo no ESAJ (`esaj.tjms.jus.br/cpopg5/`) quando o link da coluna Processo é clicado.

- Formato do n° de processo: `1111111-11.1111.8.12.0000`
  - `#numeroDigitoAnoUnificado` ← `1111111-11.1111`
  - `#foroNumeroUnificado` ← `0000`
- Botão Consultar: `#botaoConsultarProcesso` (fallback: `input[value="Consultar"]`)
- Link "Visualizar autos": `#linkPasta`
- **reCAPTCHA:** ESAJ pode retornar erro de reCAPTCHA; `clicarAbaProcesso` faz retry ×3 (2s entre tentativas) antes de desistir e fechar a aba.
- O `href` do link ESAJ na tabela SIGAD contém o n° completo via `dadosConsulta.valorConsultaNuUnificado=` — extraído por `extrairLinhasDaPagina()`.

### IDs PrimeFaces confirmados (deploy atual)

**Tabela SIGAD (`crawler.js` / `api-site.js`):**
- Filtro Situação label/panel: `formServico:tabela:j_idt381_label` / `j_idt381_panel`
- Coluna Teor da Intimação: `formServico:tabela:j_idt373`
- Coluna Disponibilização: `formServico:tabela:j_idt357`
- Coluna Processo (link ESAJ): `formServico:tabela:j_idt331` ou `j_idt367`

**Aba Partes (`api-site.js`):**
- Tabela de partes na ficha: `formServico:j_idt472:tabListaParte`
- Autocomplete Nome (Nova Parte): `formServicoParte:inputNomeParte_input` / painel: `formServicoParte:inputNomeParte_panel`
- Autocomplete Participação: `formServicoParte:inputTipoParte_input` / painel: `formServicoParte:inputTipoParte_panel`
- Ícone triangular do dropdown de Participação: `.ui-icon-triangle-1-s` dentro de `[id="formServicoParte:inputTipoParte"]` — usar esse span como alvo de clique, não o `_button` pai
- Filtros na página Pessoas (`pessoa/index.xhtml`): `formLista:j_idt312:inputNome` / `formLista:j_idt312:inputCPF`

### Controle de estado em runtime

- `data/auth.json` — cookies da sessão; reutilizado entre execuções para evitar login repetido.
- `data/resultados.json` — saída do crawler; schema: `[{ id, servico, teor, disponibilizacao, processo }]`.
- `data/pending.json` — lista de serviços ainda não processados; permite retomar o loop após interrupção. **Deletado no bloco `finally` ao fim do loop**, mesmo em caso de erro.
- `data/partes-temporarias.json` — partes extraídas das Notas por serviço. Schema: `[{ nome, cpf_cnpj, participacao, advogados: [{nome, oab}] }]`. **Deletado por `limparPartes()` ao fim de cada serviço.**

### Modo Simulação (estado atual)

Dois blocos estão deliberadamente desativados em `api-site.js`:

1. A chamada às skills (`classificarComSkill`, `proporHonorarios`) depende do resumo Gemini (Passo 4) que ainda não está implementado. Enquanto isso, o fluxo carrega `resultado-pericia.json` como mock.
2. `criarEventoEntregaProposta()` preenche o formulário mas **não salva**: o dialog é fechado via `PF('DlgEventoServico').hide()` sem clicar no botão de confirmação.

`gerarPartesDasNotas()` está **ativa** no loop — o parser `parsearPartesDeNotas()` extrai partes e advogados das Notas para `partes-temporarias.json` antes de cada serviço.

O fluxo de Partes em simulação:
- Nome encontrado no autocomplete → preenche nome + seleciona participação → processa advogados → fecha dialog sem salvar.
- Nome não encontrado → Cadastro: navega para `pessoa/index.xhtml` → preenche filtros → aguarda 3s → retorna à aba Partes.
- Advogado não encontrado → Cadastro com OAB: seleciona rádio OAB (valor `3`), preenche número + UF + nome → retorna à aba Partes.

### Parser de Partes (`parsearPartesDeNotas`)

Regex e regras críticas:

```javascript
// Suporta n°/nº/n. independente de encoding (°=U+00B0, º=U+00BA)
const OAB_RE = /OAB[\/\s]+([A-Z]{2})[^0-9]*(\d[\d.]*)/i;

// Cobre: "Advogados:", "Advogadas:", "Advogados (atuantes em diferentes fases):"
if (/^Advogad[oa]s?[^:]*:/i.test(linha)) { continue; }

// Descarta participação "Representante" e variantes
if (atual.participacao.startsWith('REPRESENTANTE')) { /* descarta */ }

// Campo reservado — não criar nova participação
const CAMPO_RESERVADO = /^(?:Nome|CPF\b[^:]*|CNPJ\b[^:]*|OAB\b[^:]*|Advogad[oa]s?[^:]*|Participa[çc][aã]o)\s*:/i;
```

### `recorder.js` — Gravador na Guia ESAJ

Usa `prepararPagina()` para abrir o SIGAD autenticado, depois `abrirGuiaProcesso()` clica no link Processo da primeira linha da tabela. A nova aba ESAJ é mantida aberta e o spy é injetado nela (re-injetado após navegações internas via `framenavigated`). Contexto gravado: `"guia-processo"`.

### Stubs pendentes

- `src/local/manipulador_word.py` — estrutura presente; implementação `python-docx` pendente.
- `src/server/sincronizador.js` — interface definida (`enviarArquivo`); credenciais SSH pendentes. Dependências já instaladas: `node-ssh`, `ssh2-sftp-client`.
- Passo 4 (Resumo Gemini) — integração pendente; atualmente substituída por mock `resultado-pericia.json`.
- UI de advogado no SIGAD — `processarUmAdvogado` navega para Cadastro mas o vínculo advogado↔parte ainda não foi mapeado via `recorder.js`. Logado com `[SIMULAÇÃO - UI de advogado não mapeada]`.

### Agendamento

`.claude/routines/rotina-diaria.json` define cron `0 8,14 * * 1-5` (América/Sao_Paulo), mas está **totalmente comentado** até os stubs serem implementados.

## Credenciais

Arquivo `.env` na raiz (não versionado):
```
SIGAD_USUARIO=
SIGAD_SENHA=
```
