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
- `src/web/claude-fallback.js` — fallbacks de IA (Claude, `claude-haiku-4-5` — mais leve; testado contra os mesmos casos reais usados para validar `claude-sonnet-5` e manteve a mesma calibração de segurança) usados pela Etapa 7: `extrairCampoDoTexto` (Etapa 7.0, campo vazio) e `avaliarSimilaridade` (Etapa 7.5, divergência textual). Ver detalhes na seção "Conferência (Etapa 7)" abaixo. `claude-haiku-4-5` não suporta `output_config.effort` — omitido nas chamadas.

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

**Clique na aba Fases não ativa de primeira (deploy 2026.07.04+):** o TabView deste deploy usa markup de jQuery UI Tabs (`ui-tabs`, não `ui-tabview`). Às vezes o `.click()` na aba Fases não lança erro e não gera `console.warn` de fallback (a aba é localizada normalmente via `TAB_FASES_CONTAINER_IDS`), mas o `activeIndex` do widget continua em `0` (Dados Básicos) — provavelmente porque o handler de clique do widget ainda não estava vinculado logo após o AJAX do Editar. Isso faz a busca pelo botão Encaminhar falhar silenciosamente (procura no painel errado, ainda oculto). Após o clique, `encaminharServico` confirma `aria-selected="true"` no `<li>` pai do link da aba e reclica em loop (até 8s) até a aba realmente ativar, antes de procurar o Encaminhar.

**Partes do ESAJ (Etapa 6):** `extrairPartesDoESAJ` adiciona sufixo de acordo com a contagem em `tableTodasPartes` para o papel (`AUTOR`/`RÉU`): mais de 1 ocorrência → ` E OUTROS` (variação única, sem distinguir singular/plural); 1 ou nenhuma → sem sufixo. A distinção singular/plural foi removida por ser redundante — `nomesBatem` (Etapa 7) já ignora essa variação na comparação, então mantê-la na extração só arriscava uma contagem incorreta gerar divergência sem motivo real.

**Conferência (Etapa 7):**
`normalizar()`: remove apóstrofo inicial (artefato do ESAJ), decodifica `&amp;`, remove acentos, maiúsculas, sufixo de estado (`/MS.`), `S/A`→`SA`, barras→espaço, `" - "`→espaço, remove pontuação, ordinais com zero (`02ª` → `2ª`), colapsa espaços, `"S A"`→`"SA"`, `"IMISSAO (DE|NA) POSSE"`→`"IMISSAO POSSE"` (classe), `"ESPOLIO DE"`→`"ESPOLIO"` (nomes — ex: `ESPÓLIO RUY BARBOSA DE MEDEIROS` == `ESPÓLIO DE RUY BARBOSA DE MEDEIROS`), `"LIMITADA"`/`"L.T.D.A"`/`"LTDA."`/`"L. T. D. A."` (pontuada, espaçada ou por extenso)→`"LTDA"`. Leniência para `"E OUTRO"`/`"E OUTROS"`/`"E OUTRA"`/`"E OUTRAS"` nos nomes de partes (compara só o nome-base, sem o sufixo de quantidade/gênero) — necessário porque o sufixo gerado a partir do ESAJ (Etapa 6) é sempre masculino, mesmo quando a parte é feminina.

**Etapa 7.0 — recuperação de campo vazio via IA (`src/web/claude-fallback.js`):** roda **antes** de `conferirEtapa7`, para `cabecalhoDoc` e, se houver, `cabecalhoAlvara`. Quando `extrairCamposSequenciais` (Etapa 5) não localizou um campo (`vara`/`foro`/`processo`/`classe`/`reqte`/`reqdo` vazio) mas o ESAJ tem valor cadastrado para o mesmo campo, `preencherCamposVaziosComIA` manda o texto bruto da 1ª página do PDF (limitado a 6000 caracteres — o cabeçalho está sempre no início) para `extrairCampoDoTexto()` (Claude, `claude-haiku-4-5`, `output_config.format` json_schema) pedindo para localizar o valor no texto. Só aplica (sobrescreve `cabecalhoDoc[chave]`) quando a resposta vem com `confianca: "alta"` — `media`/`baixa` são ignoradas e o campo segue vazio para a conferência normal. Tentativas ficam em `extracao.fallbackCampoVazio` / `fallbackCampoVazioAlvara` (mesmo padrão de `fallbackDocumentos` da Etapa 3.2); se algum campo foi de fato preenchido, marca `extracao.peticionadoPorFallbackIA = true`.

**Etapa 7.1 — fallback "todas as partes":** se autor/réu divergem mas `extrairPartesDoESAJ` retornou `todasPartes` (de `#tableTodasPartes`), testa o nome do documento contra todos os candidatos daquele papel antes de declarar divergência — não só o nome principal exibido pelo ESAJ. Só se aplica a `autor`/`reu`; os demais campos exigem match exato nesta etapa (mas podem ser resolvidos na Etapa 7.5, abaixo). Todo campo divergente (`documento principal` + `Alvará`, quando houver) é achatado numa lista única (`estados`) com um marcador `resolvidoEm` mutável — 7.1 e 7.5 vão resolvendo campo a campo, independente de qual conferência (label) ele pertence, ao contrário do `.every()` por conferência que existia antes. Sobrevivendo a 7.1, os campos restantes seguem para a Etapa 7.5.

**Etapa 7.5 — julgamento de similaridade via IA (`src/web/claude-fallback.js`):** para **todo** campo que sobrou depois da 7.1 — `autor`/`reu` sem match no `tableTodasPartes`, ou qualquer outro campo (`vara`/`foro`/`processo`/`classe`) que nunca teve fallback determinístico — `avaliarSimilaridade()` (Claude, `claude-haiku-4-5`) recebe o valor do documento e do ESAJ e decide se é o **mesmo dado/entidade** divergindo só por erro de digitação/abreviação/formatação, ou uma diferença **substantiva real** (pessoa/empresa diferente, vara/comarca diferente, etc.). Para `autor`/`reu`, não compara só contra o nome principal exibido pelo ESAJ (`est.esaj`, fixado na montagem de `estados`): testa o doc contra **cada candidato** do papel em `todasPartes` (mesma lista já usada, sem sucesso de match exato, na 7.1) além do nome principal — basta um vir `mesmoValor: true` + `confianca: "alta"` para resolver o campo. Isso evita que a IA julgue o par errado quando a 7.1 já tinha localizado um candidato quase idêntico ao doc (ex.: 1 letra de diferença) mas que não bateu por não ser idêntico — sem esse loop por candidato, a 7.5 comparava o doc contra o nome principal (uma pessoa/entidade diferente) e concluía divergência real por engano. Só libera o peticionamento quando a resposta vem `mesmoValor: true` **e** `confianca: "alta"` — qualquer campo com confiança `media`/`baixa`, ou `mesmoValor: false` em todos os candidatos testados, mantém a divergência (ex.: um caso real testado — "A.I. DOS SANTOS" vs "A.L. DOS SANTOS" — o Haiku voltou `mesmoValor: false, confianca: "alta"` — nomes de empresa a 1 letra de distância são tratados como entidades distintas, permanecendo divergente, o mesmo desfecho que o Sonnet dava com `mesmoValor: true, confianca: "media"`). `divergenciaSuperada` só é `true` quando **todos** os campos restantes (de ambas as conferências) resolvem — em 7.1 ou em 7.5. Tentativas ficam em `extracao.fallbackSimilaridadeIA.tentativas` (uma entrada por candidato testado). Qualquer erro na chamada ao Claude (rede, refusal) é tratado como resultado negativo (`confianca: "baixa"`), nunca interrompe o lote. Se, mesmo após 7.0/7.1/7.5, restar algum campo divergente, segue o fluxo já existente: notificação por e-mail (pendente) e o serviço é encaminhado com subfase `PROTOCOLAR`.

**`extracao.peticionadoPorFallbackIA`** — marcado `true` sempre que a Etapa 7.0 preencheu algum campo ou a Etapa 7.5 confirmou alguma divergência como formatação/digitação (confiança alta) e o serviço seguiu para o peticionamento normal. `gerarRelatorioExecucao` usa essa flag para listar, numa seção própria ao final do `execucao.md` ("Peticionados via fallback de IA"), os serviços cujo peticionamento dependeu de julgamento do Claude — para revisão pontual, já que a decisão não veio só de comparação determinística de texto. Divergências onde a IA foi consultada mas **não** resolveu (confiança insuficiente, ou `mesmoValor: false`) continuam aparecendo em "Pontos de Atenção", com as tentativas da IA listadas junto (mesmo padrão de `fallbackPartes`).

**Etapa 7 com Laudo + Alvará:** quando `buscarLaudo` e `fases.temAlvara`, o Alvará também tem seu cabeçalho de PDF extraído (Etapa 5, `extracao.cabecalhoAlvara`, via `fases.documentosEsperados[1]`) e conferido contra o mesmo cabeçalho ESAJ (mesmo processo) em `extracao.conferenciaAlvara` — antes disso, só o Laudo (índice 0) era checado, e o Alvará era peticionado sem qualquer verificação de conteúdo. `conferenciasPendentes` reúne as conferências (`documento principal`/`Alvará`) que falharam e roda o fallback 7.1 para cada uma independentemente (`extracao.fallbackPartes` / `extracao.fallbackPartesAlvara`); `divergenciaSuperada` só é `true` se **ambas** resolverem. Se qualquer uma permanecer divergente, a aba ESAJ é fechada sem peticionar nenhum dos dois documentos e o serviço é encaminhado com subfase `PROTOCOLAR` — igual ao padrão das demais divergências. Fora do fluxo Laudo+Alvará (`cabecalhoAlvara` não extraído), o comportamento é idêntico ao anterior.

**Classe "Incidente" (Etapa 6):** processos incidentais (ex.: Incidente de Desconsideração de Personalidade Jurídica) não renderizam `#classeProcesso`. `extrairCabecalhoDoESAJ` cai para um fallback estrutural sem id (mapeado via DevTools Recorder): `#containerDadosPrincipaisProcesso > div:first-of-type > div > div > span.unj-larger` (ou o primeiro `span.unj-larger` dentro do mesmo bloco, se a estrutura variar). O span traz o nº do processo entre parênteses junto do texto (ex.: `"... (0008573-14.2023.8.12.0001)"`) — removido antes de retornar. `console.warn` sinaliza quando esse fallback é usado, para validar contra casos reais.

**Etapa 7.3 — Laudo acima do limite de import do ESAJ:** o ESAJ rejeita petições com arquivo acima de ~30 MB; na prática só o documento da aba Laudos (quando `buscarLaudo` é `true`) tende a estourar esse tamanho. Antes de peticionar, `processarServico` confere `fs.statSync` do PDF em `pastaRecente` contra `LIMITE_TAMANHO_LAUDO_BYTES` (`LIMITE_TAMANHO_LAUDO_MB = 29.99`, topo do arquivo). Se exceder, segue o mesmo padrão de divergência das Etapas 3/5/7: fecha a aba ESAJ, encaminha no SIGAD com subfase `PROTOCOLAR` e retorna `{ ok: false, motivo }` — que cai automaticamente em "Pontos de Atenção" no `execucao.md` (nenhuma mudança necessária em `gerarRelatorioExecucao`).

**Etapa 7.4 — PDF a peticionar ausente na pasta:** antes de abrir qualquer formulário de petição, `processarServico` confere se todo PDF que será enviado (documento principal e, se `fases.temAlvara`, também o Alvará) existe em `pastaRecente`, via `localizarArquivoDocumento` (mesma busca fuzzy — nome do arquivo contém o código do documento — usada na Etapa 5 para o cabeçalho). Sem essa checagem, um Alvará ausente só era descoberto dentro do loop de `peticionarNoESAJ` (Etapas 8-10), depois do documento principal já ter sido protocolado, travando a execução com um `ENOENT` sem possibilidade de desfazer o protocolo já feito. Se faltar algum PDF, segue o mesmo padrão de divergência: fecha a aba ESAJ, encaminha no SIGAD com subfase `PROTOCOLAR` e retorna `{ ok: false, motivo }`. `peticionarNoESAJ` também usa `localizarArquivoDocumento` (em vez de concatenar `código + '.pdf'`) para resolver o caminho de cada arquivo — evita ENOENT quando o nome real em disco traz sufixos/prefixos além do código puro.

**Etapa 7.5 — confere o rodapé (alinhado à paginação):** a 1ª linha não vazia da 1ª página de cada PDF a peticionar traz `"<código do doc>  <nº da página>"` (ex: `"L26185_8607  1"`) — usado para confirmar que o PDF resolvido por `localizarArquivoDocumento` (busca fuzzy por nome de arquivo) é de fato o documento esperado, e não outro arquivo que só contém o código como substring do nome. `extrairCodigoRodape` ancora a extração no código já conhecido (`nomeDocumento`), aceitando zero ou mais espaços antes do nº de página — necessário porque alguns PDFs não têm espaço nenhum entre os dois (ex.: `"VCP19240_684401"`, serviço 19.240: código `VCP19240_68440` + página `1` grudados). Sem essa âncora, um regex genérico (`RODAPE_PAGINACAO_RE`, que exige espaço) simplesmente não casava a linha inteira e `codigoRodape` voltava `null`, gerando divergência falsa mesmo com o código correto no rodapé. `RODAPE_PAGINACAO_RE` continua existindo só como fallback de diagnóstico, para quando o código encontrado realmente é outro (documento errado) — nesse caso não há como ancorar no esperado, então extrai o que aparece para log.

**Documentos (Etapa 3):** o Alvará é identificado por `tipoDocumento.toUpperCase().includes('ALVARA')` — **sem acento**, pois o SIGAD retorna o campo sem acentuação (ver `[[project_sigad_alvara]]` em memória). Se vier em índice 0, a lista é invertida para o Alvará ficar sempre em índice 1 (doc2). `responsavel` só é preservado no documento principal.

**Etapa 3.2 — fallback "doc fora dos mais recentes":** `extrairDocumentos` só lê os `qtd` (1 ou 2) primeiros registros da aba Documentos; se um doc de outra fase for mais recente, o(s) doc(s) esperado(s) da Fase atual pode(m) ficar fora desse recorte e `conferirDocumentos` falha. Antes de declarar divergência real, `processarServico` varre a aba Documentos por completo (`buscarDocumentoNaAba`, via `extrairLinhasDocumentos` sem slice) procurando cada código de `fases.documentosEsperados` que ainda não bateu. No fluxo de Laudo (`buscarLaudo`), o índice 0 (doc principal) nunca é buscado aqui — vem exclusivamente da aba Laudos; só o Alvará (índice 1) pode ser resgatado por esse fallback. Tentativas ficam registradas em `extracao.fallbackDocumentos` (mesmo padrão de `fallbackPartes` da Etapa 7.1). Se algum código realmente não existir na aba, segue o fluxo de divergência já existente: encaminha no SIGAD com subfase `PROTOCOLAR`.

**Fase Laudo (Etapa 3.1):** quando `fases.fase` contém "Laudo" **e** a subfase normalizada é exatamente `PROTOCOLAR` (`buscarLaudo` em `processarServico`), o documento principal não é peticionado a partir da aba Documentos — vem da aba Laudos (`extrairAbaLaudos()`), validado via `teste-laudo.js`. Se a subfase for `PROTOCOLAR-[subtipo]` (ex: `PROTOCOLAR - PRAZO`, normalizada removendo espaços ao redor do hífen — mesmo padrão de `resolverCodigoClassificacao`), a aba Laudos **não é buscada**: segue o fluxo normal de Documentos igual às demais Fases, pois esses subtipos não têm laudo a protocolar. Diferente de Documentos/Fases (`p:dataTable` com thead/tbody), a aba Laudos é um `p:dataGrid` (um cartão `.ui-panel` por laudo, sem colunas): a extração localiza o grid pelo id fixo `[id$=":servico_content"]` (estável entre deploys, ao contrário dos `j_idt*`) e lê o texto de cada cartão via `innerText` (nunca `textContent` de um clone destacado do DOM — retorna vazio, pois depende do layout renderizado). O código do documento (ex: `L28639_8398`) não fica dentro de `a.ui-commandlink` (esse link não carrega texto próprio); é identificado por padrão (`/^[A-Za-z]+\d+_\d+$/`) nas linhas de texto do cartão. Com Alvará, o Laudo não ocupa nenhuma linha na aba Documentos — por isso não há "2 mais recentes" a recortar ali como no fluxo normal. `extrairAlvaraMaisRecente()` (dedicada a esse caso) clica na aba Documentos, lê **todas** as linhas renderizadas (`extrairLinhasDocumentos`, sem slice) e retorna diretamente a primeira com `tipoDocumento` contendo "ALVARA" — **não assumir que a linha mais recente em Documentos é o Alvará**: pode ser um documento antigo/irrelevante de outra fase (ex: "PRAZO"), por isso a busca é por tipo, não por posição. `responsavel` é zerado (o Alvará nunca é o documento principal). Por ler a aba inteira desde já, a Etapa 3.2 (fallback "doc fora dos mais recentes") é redundante para esse índice — só permanece relevante para o fluxo normal (fora de `buscarLaudo`), que ainda usa `extrairDocumentos` com recorte por posição.

**Extração do cabeçalho do PDF (Etapa 5):** `extrairCamposSequenciais()` é uma máquina de estados — cada campo (`AO JUÍZO`, `AUTOS`, `AÇÃO`, autor, réu) só é buscado depois que o campo anterior na ordem do documento foi encontrado/descartado, evitando capturar "AÇÃO" de menções tardias no corpo. `SIGLAS_AUTOR`/`SIGLAS_REU` (topo do arquivo) cobrem rótulos abreviados/extensos com `[OA]` para gênero (ex: `EXECUTAD[OA]`). Fallback de linha única quando o autor não é capturado pela máquina de estados: regex que extrai autor+réu embutidos na mesma linha da Ação.

**Quebra de linha em "...NA PESSOA DO SEU INVENTARIANTE" (Etapa 5):** `INVENTARIANTE(S)` está em `SIGLAS_AUTOR` (rótulo de campo genuíno em ações de inventário, ex: `INVENTARIANTE: FULANO`), mas também aparece como palavra comum dentro do próprio nome de réu/autor no idiomatismo `"ESPÓLIO DE X, NA PESSOA DO(A) SEU(SUA) INVENTARIANTE..."`. Quando esse nome (longo) quebra de linha logo antes de "INVENTARIANTE", `INICIO_CAMPO` confundia a palavra com um novo rótulo de campo e fechava `reqte`/`reqdo` cedo demais, perdendo o resto do nome — ex. real, serviço 28.531: capturava só `"ESPÓLIO TEOBALDO FERREIRA, NA PESSOA DO SEU"`, descartando a linha seguinte `"INVENTARIANTE E OUTROS"`, o que gerava divergência falsa na Etapa 7 contra o ESAJ (que tem o nome completo). `CONTINUACAO_INVENTARIANTE_RE` + `FIM_PESSOA_DO_SEU_RE` (topo do arquivo) tratam esse caso: se a linha em captura de nome de parte (`reqte`/`reqdo`) começa com `INVENTARIANTE(S)` **e** a última linha já capturada termina em `SEU`/`SUA`, a linha é tratada como continuação do nome, não como novo campo. Não interfere no caso genuíno de `"INVENTARIANTE:"` abrindo um campo do zero (`capturandoKey` ainda nulo nesse caso).

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
ANTHROPIC_API_KEY=
# GMAIL_USUARIO=
# GMAIL_APP_PASSWORD=
```

`ANTHROPIC_API_KEY` é obrigatória a partir das Etapas 7.0/7.5 (fallbacks de IA em `src/web/claude-fallback.js`, dependência `@anthropic-ai/sdk`) — sem ela, qualquer divergência na Etapa 7 falha ao chamar o Claude e cai no fluxo normal de divergência (subfase `PROTOCOLAR`), já que erros de chamada são tratados como resultado negativo, não interrompem o lote.
