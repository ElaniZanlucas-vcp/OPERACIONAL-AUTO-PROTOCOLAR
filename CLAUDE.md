# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Fluxo completo (Etapas 2-11)
node src/web/auto-protocolar.js

# Encaminhar isolado — dois submodos decididos pelos arquivos em data/ (ver abaixo)
node src/web/auto-protocolar.js etapa11

# Gravador de interações na guia ESAJ (desenvolvimento — mapear seletores)
node src/web/recorder.js

# Teste isolado de extração de partes/cabeçalho do ESAJ (edite PROCESSOS_ALVO no arquivo)
node src/web/teste-partes.js

# Teste isolado de extração da aba Laudos/Documentos no SIGAD (edite SERVICOS_ALVO no arquivo)
node src/web/teste-laudo.js
```

Não há suite de testes nem linter configurados neste projeto.

## Arquitetura

### Script principal

**`auto-protocolar.js`** executa as etapas 2-11 por serviço:
- Etapas 2-4: lê Fases, Documentos e Dados Básicos do SIGAD; abre processo no ESAJ.
- Etapas 5-7: extrai cabeçalho do PDF no servidor; extrai partes + cabeçalho do ESAJ; confere os dois.
- Etapas 8-10: peticiona documento(s) no ESAJ (loop duplo se há Alvará).
- Etapa 11: encaminha no SIGAD (Editar → Fases → Encaminhar → Salvar).
- Modo `etapa11`: dois submodos pelos arquivos em `data/` — batch (`encaminhar.json`) ou retomada (`extracao-protocolo.json`).
- `SERVICOS_EXCLUIDOS` (array no topo do arquivo, normalizado sem pontos) — serviços nunca incluídos em `pending.json`. Atualmente: `['26872']`.
- Divergências nas Etapas 3, 5, 7 e 7.3 **não pulam mais o serviço**: encaminham no SIGAD com subfase `PROTOCOLAR` (em vez de `AGUARDAR PROTOCOLO`) e seguem para o próximo serviço do loop.

### Fluxo web (Playwright / PrimeFaces)

O SIGAD usa JSF + PrimeFaces. Regras que afetam todos os scripts:

1. **`aguardarAjax(page)`** — deve ser chamado após qualquer interação; espera `PrimeFaces.ajax.Queue.isEmpty()` pois keepalives bloqueiam `networkidle` indefinidamente.
2. **IDs dinâmicos** — formato `formServico:tabela:j_idt345`. Estáveis por sessão, mas podem mudar entre deploys. Seletores usam `[id="..."]`, nunca CSS com `:`. Manter fallbacks no objeto `SEL` de `auto-protocolar.js`.
3. **`prepararPagina()`** em `crawler.js` — retorna `{ browser, context, page }` já logado e com filtro `Situação = Cadastro`. Ponto de entrada correto para `recorder.js`.
   - `abrirBrowser()` (usado por todo script que abre o Chromium) mata `chrome.exe`/`chrome_crashpad_handler.exe` antes de lançar e clona o perfil real do Chrome do usuário (`%LOCALAPPDATA%/Google/Chrome/User Data`) na 1ª execução — mantém certificado digital, extensões e login Google em `data/chrome-profile`. Qualquer Chrome aberto pelo usuário é fechado ao iniciar qualquer script deste projeto.
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
Os IDs mudam entre deploys (`j_idt474:j_idt545` → `j_idt436:j_idt507` → `j_idt438:j_idt509`, e assim por diante). `encaminharServico()` resolve aba Fases, botão Encaminhar, botão Salvar Fase e botão Salvar Detalhes em 3 níveis, nessa ordem:
1. Testa cada ID das listas `TAB_FASES_CONTAINER_IDS` / `BTN_ENCAMINHAR_IDS` / `BTN_SALVAR_FASE_IDS` / `BTN_SALVAR_DETALHES_IDS` (topo do arquivo) via `[id="..."]`.
2. Se nenhum visível, cai para seletor genérico por DOM/texto (ex: `.ui-tabview-nav a:has-text("Fases")`; botão `.ui-button` habilitado com texto `/encaminhar|salvar/i` excluindo `/cancelar|fechar/i`).
3. `console.warn` imprime o ID real resolvido pelo fallback — **adicionar esse ID à respectiva lista `*_IDS`** para fixar o seletor no próximo deploy. Se nem o fallback resolver, lança `Error`.

**Conferência (Etapa 7):**
`normalizar()`: remove apóstrofo inicial (artefato do ESAJ), decodifica `&amp;`, remove acentos, maiúsculas, sufixo de estado (`/MS.`), `S/A`→`SA`, barras→espaço, `" - "`→espaço, remove pontuação, ordinais com zero (`02ª` → `2ª`), colapsa espaços, `"S A"`→`"SA"`. Leniência para `"E OUTROS"` nos nomes de partes (compara só o primeiro nome).

**Etapa 7.1 — fallback "todas as partes":** se autor/réu divergem mas `extrairPartesDoESAJ` retornou `todasPartes` (de `#tableTodasPartes`), testa o nome do documento contra todos os candidatos daquele papel antes de declarar divergência — não só o nome principal exibido pelo ESAJ. Só se aplica a `autor`/`reu`; os demais campos exigem match exato. Sobrevivendo a 7.1, a divergência segue para a notificação por e-mail (pendente) e o serviço é encaminhado com subfase `PROTOCOLAR`.

**Etapa 7.3 — Laudo acima do limite de import do ESAJ:** o ESAJ rejeita petições com arquivo acima de ~30 MB; na prática só o documento da aba Laudos (quando `buscarLaudo` é `true`) tende a estourar esse tamanho. Antes de peticionar, `processarServico` confere `fs.statSync` do PDF em `pastaRecente` contra `LIMITE_TAMANHO_LAUDO_BYTES` (`LIMITE_TAMANHO_LAUDO_MB = 29.99`, topo do arquivo). Se exceder, segue o mesmo padrão de divergência das Etapas 3/5/7: fecha a aba ESAJ, encaminha no SIGAD com subfase `PROTOCOLAR` e retorna `{ ok: false, motivo }` — que cai automaticamente em "Pontos de Atenção" no `execucao.md` (nenhuma mudança necessária em `gerarRelatorioExecucao`).

**Documentos (Etapa 3):** o Alvará é identificado por `tipoDocumento.toUpperCase().includes('ALVARA')` — **sem acento**, pois o SIGAD retorna o campo sem acentuação (ver `[[project_sigad_alvara]]` em memória). Se vier em índice 0, a lista é invertida para o Alvará ficar sempre em índice 1 (doc2). `responsavel` só é preservado no documento principal.

**Fase Laudo (Etapa 3.1):** quando `fases.fase` contém "Laudo" **e** a subfase normalizada é exatamente `PROTOCOLAR` (`buscarLaudo` em `processarServico`), o documento principal não é peticionado a partir da aba Documentos — vem da aba Laudos (`extrairAbaLaudos()`), validado via `teste-laudo.js`. Se a subfase for `PROTOCOLAR-[subtipo]` (ex: `PROTOCOLAR - PRAZO`, normalizada removendo espaços ao redor do hífen — mesmo padrão de `resolverCodigoClassificacao`), a aba Laudos **não é buscada**: segue o fluxo normal de Documentos igual às demais Fases, pois esses subtipos não têm laudo a protocolar. Diferente de Documentos/Fases (`p:dataTable` com thead/tbody), a aba Laudos é um `p:dataGrid` (um cartão `.ui-panel` por laudo, sem colunas): a extração localiza o grid pelo id fixo `[id$=":servico_content"]` (estável entre deploys, ao contrário dos `j_idt*`) e lê o texto de cada cartão via `innerText` (nunca `textContent` de um clone destacado do DOM — retorna vazio, pois depende do layout renderizado). O código do documento (ex: `L28639_8398`) não fica dentro de `a.ui-commandlink` (esse link não carrega texto próprio); é identificado por padrão (`/^[A-Za-z]+\d+_\d+$/`) nas linhas de texto do cartão. Com Alvará, `extrairDocumentos` ainda busca os 2 documentos mais recentes normalmente, mas só a entrada com `tipoDocumento` contendo "ALVARA" é aproveitada — **não assumir que a linha mais recente em Documentos é o Alvará**: pode ser um documento antigo/irrelevante de outra fase (ex: "PRAZO"), com o Alvará na 2ª posição.

**Extração do cabeçalho do PDF (Etapa 5):** `extrairCamposSequenciais()` é uma máquina de estados — cada campo (`AO JUÍZO`, `AUTOS`, `AÇÃO`, autor, réu) só é buscado depois que o campo anterior na ordem do documento foi encontrado/descartado, evitando capturar "AÇÃO" de menções tardias no corpo. `SIGLAS_AUTOR`/`SIGLAS_REU` (topo do arquivo) cobrem rótulos abreviados/extensos com `[OA]` para gênero (ex: `EXECUTAD[OA]`). Fallback de linha única quando o autor não é capturado pela máquina de estados: regex que extrai autor+réu embutidos na mesma linha da Ação.

**Loop de peticionamento (Etapas 8-10):**
- Documento principal sempre primeiro (código por Fase/Subfase).
- Se `temAlvara`: após salvar o doc principal, retorna ao SIGAD (`page.bringToFront()`), reabre o processo via Etapa 4 para nova aba ESAJ e repete com código 38380.

**Modo etapa11 — batch vs retomada:**
- **Batch** (`data/encaminhar.json` existe): lê array `[{ servico, observacao, subfase? }]`, processa item a item, regravando o arquivo a cada sucesso (retomável) e apagando-o ao final.
- **Retomada** (sem batch, com `data/extracao-protocolo.json`): lê `servico` e `fases.observacao` da última extração → clica no serviço na tabela → navega para aba Dados Básicos → chama `encaminharServico` com subfase default.

### IDs PrimeFaces confirmados (deploy atual)

**Tabela SIGAD (`crawler.js`):**
- Filtro Situação label/panel: `formServico:tabela:j_idt381_label` / `j_idt381_panel`
- Coluna Teor da Intimação: `formServico:tabela:j_idt373`
- Coluna Disponibilização: `formServico:tabela:j_idt357`
- Coluna Processo (link ESAJ): `formServico:tabela:j_idt331` ou `j_idt367`

**Dialog do serviço — Etapas 2-4:**
- Abas: `formDlgVerServico:tabViewEvento` → `a:has-text("Fases" | "Documentos" | "Laudos" | "Dados Básicos")`
- Tabela fases: `formDlgVerServico:tabViewEvento:tabListaFase_data`
- Tabela documentos: `formDlgVerServico:tabViewEvento:tabListaDocumento_data`
- Grid de laudos (`p:dataGrid`, sem thead/tbody): `formDlgVerServico:tabViewEvento:servico_content` — id "servico" é fixo, só os `j_idt*` internos de cada cartão mudam entre deploys.

**Etapa 11 — Encaminhar (cascata de IDs + fallback DOM/texto):**
- Botão Editar: `[id="formDlgVerServico"] span.ui-button-text:has-text("Editar")`
- Aba Fases pós-Editar (`TAB_FASES_CONTAINER_IDS`): `j_idt474` → `j_idt436` → `j_idt438`
- Botão Encaminhar (`BTN_ENCAMINHAR_IDS`): `formServico:j_idt474:j_idt545` → `formServico:j_idt436:j_idt507` → `formServico:j_idt438:j_idt509`
- Autocomplete Nome: `formDlgEnviarServico:inputUsuario_input`
- Subfase: `formDlgEnviarServico:inputSubfase_label` / `inputSubfase_panel`
- Observação: `formDlgEnviarServico:inputObsFase`
- Salvar Fase (`BTN_SALVAR_FASE_IDS`): `formDlgEnviarServico:j_idt714` → `j_idt750` → `j_idt712`
- Salvar Detalhes (`BTN_SALVAR_DETALHES_IDS`): `formServico:j_idt471` → `formServico:j_idt433`

### Controle de estado em runtime

- `data/auth.json` — cookies da sessão; reutilizado entre execuções para evitar login repetido.
- `data/pending.json` — lista de serviços não processados; deletado no bloco `finally` ao fim do loop.
- `data/extracao-protocolo.json` — estado acumulado por serviço; atualizado após cada etapa via `salvarExtracao()`; preservado para retomada via `etapa11`.
- `data/encaminhar.json` — entrada manual para o submodo batch de `etapa11`: `[{ servico, observacao, subfase? }]`; consumido item a item e apagado ao final.
- `data/chrome-profile/` — perfil persistente do Chromium, clonado do perfil real do Chrome do usuário na 1ª execução (`crawler.js#abrirBrowser`).
- `data/teste-partes-resultado.json` — saída de `teste-partes.js` (partes + cabeçalho por processo testado).
- `data/teste-laudo-resultado.json` — saída de `teste-laudo.js` (Fases, Documentos filtrados e Laudos por serviço testado).

### Stubs pendentes

- `src/server/sincronizador.js` — interface definida (`enviarArquivo`); credenciais SSH pendentes.
- Notificação de divergência (Etapa 7.2) — código comentado em `auto-protocolar.js`; requer `GMAIL_USUARIO`/`GMAIL_APP_PASSWORD` no `.env`.
- `main.js` (`npm run pre`) — stub legado quebrado: chama `login()` de `auth.js`, que hoje exporta `fazerLogin`/`loadSession`. Não usar.

## Credenciais

Arquivo `.env` na raiz (não versionado):
```
SIGAD_USUARIO=
SIGAD_SENHA=
TRABALHOS_FINAIS=
# GMAIL_USUARIO=
# GMAIL_APP_PASSWORD=
```
