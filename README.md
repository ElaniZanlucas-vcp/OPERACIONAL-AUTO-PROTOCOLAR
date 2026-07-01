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
│ ║      Reordena: Alvará (Tipo Documento) sempre em índice 1        ║
│ ║      Não confere com Observação da Fase →                        ║
│ ║        encaminha c/ subfase PROTOCOLAR (não pula mais)           ║
│ ║                                                                  ║
│ ║  [Etapa 4]  Dados Básicos → abre ESAJ em nova aba ──────── ✔    ║
│ ║      Retry ×3 se reCAPTCHA (#linkPasta ausente)                  ║
│ ║                                                                  ║
│ ║  [Etapa 5]  Localizar pasta no servidor ───────────────── ✔     ║
│ ║      TRABALHOS_FINAIS/<servico>/<subpasta_mais_recente>/         ║
│ ║      Extrai cabeçalho da 1ª pág do PDF (state machine seq.):     ║
│ ║      vara, foro, n° processo, classe, reqte (autor), reqdo (réu) ║
│ ║      Pasta/PDF não encontrado →                                  ║
│ ║        encaminha c/ subfase PROTOCOLAR                           ║
│ ║                                                                  ║
│ ║  [Etapa 6]  Extrair partes + cabeçalho do ESAJ ────────── ✔     ║
│ ║      (paralelo) Autor + Réu; "E OUTROS" se tableTodasPartes      ║
│ ║      Também retorna todasPartes (candidatos p/ fallback 7.1)     ║
│ ║      Cabeçalho: classe, foro, vara, n° processo — tudo maiúsculo ║
│ ║                                                                  ║
│ ║  [Etapa 7]  Conferir doc × ESAJ ──────────────────────── ✔      ║
│ ║      Compara: vara, foro, processo, classe, autor, réu           ║
│ ║      [7.1] Falha em autor/réu → testa candidatos de              ║
│ ║        tableTodasPartes antes de declarar divergência            ║
│ ║      Divergência → notificação e-mail ⚙ pendente →               ║
│ ║        encaminha c/ subfase PROTOCOLAR (não pula mais)           ║
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

**Serviços excluídos:** `SERVICOS_EXCLUIDOS` em `auto-protocolar.js` — lista de números (sem pontos) ignorados ao montar `pending.json`. Atualmente: `26872`.

**Retomada / Encaminhar isolado:** `node src/web/auto-protocolar.js etapa11` roda em dois modos, decididos pelos arquivos presentes em `data/`:
- **Batch** (`data/encaminhar.json` presente) — array `[{ "servico", "observacao", "subfase"? }]`; processa um a um, removendo cada item do arquivo após sucesso (subfase default `AGUARDAR PROTOCOLO`).
- **Retomada** (sem batch, com `data/extracao-protocolo.json`) — reencaminha o último serviço processado pelo fluxo completo.

---

## 2. Scripts

| Script | Responsabilidade |
|--------|-----------------|
| `src/web/auto-protocolar.js` | Fluxo principal: Fases, Documentos, ESAJ, Peticionar, Encaminhar |
| `src/web/auth.js` | Login no SIGAD, salva cookies em `data/auth.json` |
| `src/web/crawler.js` | Filtra tabela, extrai todas as páginas → `data/resultados.json` |
| `src/web/recorder.js` | Grava interações na guia de processo para mapear seletores |
| `src/web/teste-partes.js` | Utilitário isolado: testa `extrairPartesDoESAJ`/`extrairCabecalhoDoESAJ` contra uma lista fixa de processos (`PROCESSOS_ALVO`), sem depender do SIGAD |
| `src/server/sincronizador.js` | Upload SFTP ao servidor (stub) |
| `main.js` | ⚠ Stub legado (`npm run pre`) — chama `login()` de `auth.js`, que não é mais exportado (`fazerLogin`/`loadSession`). Quebrado; não usar |

---

## 3. Fluxos Detalhados

### 3.1 Login e Sessão (`auth.js` + `crawler.js`)

- `auth.js`: lê `SIGAD_USUARIO` / `SIGAD_SENHA` do `.env`, preenche o formulário de login e salva cookies em `data/auth.json`.
- `auto-protocolar.js` detecta sessão SIGAD ativa pela presença de `"Painéis"` no menu; refaz o login automaticamente se expirou.
- `abrirBrowser()` em `crawler.js` — usa `chromium.launchPersistentContext` (canal `chrome`) sobre `data/chrome-profile`:
  1. **1ª execução:** `clonarPerfilChrome()` clona o perfil real do Chrome do usuário (`%LOCALAPPDATA%/Google/Chrome/User Data/<CHROME_PROFILE ou Default>`) via `robocopy`, excluindo caches — preserva certificado digital, extensões e login Google.
  2. **Toda execução:** mata `chrome.exe`/`chrome_crashpad_handler.exe` (`taskkill`) e aguarda até 10s o processo encerrar, liberando acesso exclusivo ao diretório do perfil; remove `SingletonLock`/`SingletonCookie`/`SingletonSocket`/`lockfile` residuais antes de lançar — evita o erro "sessão já existente" do Chrome.
  3. Carrega cookies de `data/auth.json` no contexto, se existir.

**Importante:** como reaproveita o perfil real, qualquer Chrome aberto pelo usuário é fechado ao iniciar o script.

**Workaround técnico:** PrimeFaces mantém conexões keepalive que bloqueiam `networkidle`. `aguardarAjax()` espera `PrimeFaces.ajax.Queue.isEmpty()` antes de prosseguir.

---

### 3.2 Etapa 2 — Fases

Clica na aba Fases do dialog `formDlgVerServico`. Lê a primeira linha de `tabListaFase_data`: Fase, Subfase, Observação. A Observação contém os nomes dos documentos esperados (doc2, quando presente, é sempre Alvará).

**`parsearDocsObservacao()` — separadores em cascata:**
1. `//` — separador padrão.
2. `;` — fallback se não há `//`.
3. `" - "` — só é tratado como separador quando **ambos** os lados parecem código de documento (`letras+dígito`, sem espaço interno); caso contrário é tratado como sufixo de descrição e descartado.

Cada token passa por `extrairCodigo()`, que corta a descrição após o código (`"CÓDIGO - descrição"`, `"CÓDIGO. descrição"`, `"CÓDIGO descrição"`) — exceto códigos puramente numéricos (ex: `38380`), devolvidos inteiros.

---

### 3.3 Etapa 3 — Documentos

Clica na aba Documentos. Extrai 1 ou 2 documentos mais recentes (Documento, Tipo Documento, Responsável).

- **Reordenação do Alvará:** se há Alvará, garante que ele fica sempre no índice 1 (doc2) checando `tipoDocumento.toUpperCase().includes('ALVARA')` — sem acento, pois o ESAJ retorna o campo sem acentuação (ver [[project_sigad_alvara]]). Inverte a ordem se o Alvará veio em índice 0.
- **Responsável** só é mantido para o documento principal (índice 0); zerado (`null`) nos demais.
- Confere se os nomes batem (lowercase `includes`) com os da Observação — caso contrário **não pula mais o serviço**: encaminha no SIGAD com subfase `PROTOCOLAR` (ver 3.7) e segue para o próximo serviço.

---

### 3.4 Etapa 4 — Dados Básicos → ESAJ

Clica na aba Dados Básicos e localiza o span com o n° de processo (`/\d{7}-\d{2}\.\d{4}/`). Clica para abrir nova aba ESAJ. Retry ×3 aguardando `#linkPasta` aparecer. Se a sessão ESAJ expirou, `loginEsaj` re-autentica via certificado.

---

### 3.5 Etapa 5 — Servidor (Trabalhos Finais)

- Lê `TRABALHOS_FINAIS` do `.env`.
- Abre `<TRABALHOS_FINAIS>/<numero_servico_sem_pontos>/` e seleciona a subpasta mais recente (por `mtime`).
- Usa `pdf-parse` (`{ max: 1 }`) para ler apenas a 1ª página do PDF, normaliza `text.normalize('NFC')` (recompõe acentos decompostos) e extrai os campos via `extrairCamposSequenciais()`.
- Falha ao localizar pasta/PDF → não pula mais o serviço: encaminha no SIGAD com subfase `PROTOCOLAR` e segue para o próximo.

**`extrairCamposSequenciais()` — máquina de estados sequencial:**
Os campos (`AO JUÍZO`, `AUTOS`, `AÇÃO`, autor, réu) só são procurados **na ordem do documento** — cada campo é buscado apenas após o anterior ter sido encontrado (ou descartado). Isso impede capturar "AÇÃO" de uma menção tardia no corpo do documento (ex: "CERTIFICAÇÃO"). Campos multilinhas são unidos; linha em branco fecha o campo capturado, exceto `aoJuizo` (pode quebrar entre vara/foro — só fecha ao encontrar outro campo conhecido).

**Siglas de partes (`SIGLAS_AUTOR` / `SIGLAS_REU`):** listas de rótulos abreviados e por extenso usados no cabeçalho de documentos judiciais, cobrindo masculino/feminino unificado com `[OA]` (ex: `EXECUTAD[OA]`):
- Autor: `REQTE`, `EXEQTE`, `EXEQUENTE`, `LIQUIDANTE`, `LIQTE`, `INVENTARIANTE`, `IMPUGNANTE`, `IMPUGTE`, `RECONVINTE`, `RECONVTE`, `EMBARGANTE`, `EMBARGTE`.
- Réu: `REQD[OA]`, `EXECTD[OA]`, `EXECUTAD[OA]`, `LIQUIDAD[OA]`, `LIQD[OA]`, `INVENTARIAD[OA]`, `INVTD[OA]`, `IMPUGNAD[OA]`, `IMPUGD[OA]`, `RECONVIND[OA]`, `RECONVD[OA]`, `EMBARGAD[OA]`, `EMBARGD[OA]`.

**Fallback de linha única:** quando `reqte` não é encontrado pela máquina de estados, tenta um regex único que captura autor e réu embutidos na mesma linha da Ação — ex: `"LIQUIDAÇÃO POR ARBITRAMENTO EXEQTE: RAMÃO ALVES EXECTDO: PAX NACIONAL..."`.

---

### 3.6 Etapa 6 — Partes + Cabeçalho do ESAJ (paralelo)

- **`extrairPartesDoESAJ`**: lê `#tablePartesPrincipais` (nomes) e `#tableTodasPartes` (contagem/candidatos por papel, quando existe). Classifica cada label → `AUTOR`/`RÉU` via `classificarRoleESAJ()` — lista de regexes por rótulo abreviado/extenso (ex: `^EXEQ`, `^REQ(T|NT|UER)`, `^RECLAM(T|ANT)`, `^EMBARG(T|ANT|ANTE|UE)`, `^IMPET(T|RANT)`, `^LIQ(T|ANT|UIDAN)`, `^INV(ANT|ARIAN)`, `^IMPUGN(T|ANT|ANTE)`, `^RECONVINT` para autor; análogos com sufixo `D`/`AD`/`UT`/`UID` para réu), ignorando linhas de Advogado(a) e valores `SEM ...`. Adiciona ` E OUTROS` ao nome quando `tableTodasPartes` tem mais de uma ocorrência do papel.
- Retorna `{ partes, todasPartes }` — `todasPartes` é `{ AUTOR: [...], 'RÉU': [...] }` com **todos** os nomes classificados em `tableTodasPartes` (não só o primeiro de cada papel); usado como pool de candidatos pelo fallback da Etapa 7.1.
- **`extrairCabecalhoDoESAJ`**: lê `#classeProcesso`, `#foroProcesso`, `#varaProcesso` (fallback via `th` label). Tudo em maiúsculo.
- A mesma lógica de extração de partes existe duplicada em `src/web/teste-partes.js`, usada para testar contra uma lista fixa de processos sem rodar o fluxo completo (ver 3.12).

---

### 3.7 Etapa 7 — Conferência doc × ESAJ

`normalizar()` aplica, em ordem: remove apóstrofo inicial (artefato do ESAJ), decodifica `&amp;` → `&`, remove acentos, maiúsculas, remove sufixo de estado no foro (`/MS.`, `/MT.` etc.), `S/A` → `SA` (antes de tratar barras), barras restantes → espaço, `" - "` → espaço (ex: `"Comaves - Industria"` → `"Comaves Industria"`), remove pontuação, ordinais com zero (`02ª` → `2ª`), colapsa espaços e por fim `"S A"` → `"SA"` (caso a remoção de pontos tenha deixado `S. A.` como `"S A"`). Compara campo a campo: vara, foro, processo, classe, autor, réu. Leniência para `"E OUTROS"` nos nomes (compara só o primeiro nome).

**Etapa 7.1 — Fallback "verificar todas as partes":** quando autor e/ou réu divergem mas `todasPartes` (Etapa 6) está disponível, testa o nome do documento contra **todos** os candidatos daquele papel em `tableTodasPartes` (não só o nome principal do ESAJ) antes de declarar divergência. Loga cada tentativa (`doc="..." candidatos=[...] → [OK]/[XX]`). Só campos `autor`/`reu` usam este fallback — vara/foro/processo/classe continuam exigindo match exato.

Divergência que sobrevive ao fallback 7.1 → notificação por e-mail pendente (`GMAIL_USUARIO`/`GMAIL_APP_PASSWORD`, ver 4) → **não pula mais o serviço**: encaminha no SIGAD com subfase `PROTOCOLAR` e segue para o próximo.

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

1. Clica em **Editar** no dialog → formulário abre em `formServico`.
2. Clica na aba **Fases**.
3. Clica em **Encaminhar** → dialog `formDlgEnviarServico`.
4. Preenche Nome via autocomplete (`pressSequentially` + seleciona 1° resultado).
5. Seleciona Subfase (default `AGUARDAR PROTOCOLO`, mas `PROTOCOLAR` nos fallbacks de erro das etapas 3/5/7).
6. Preenche Observação (triple-click + `fill`).
7. **Salvar Fase** → **Salvar Detalhes**.

**Resolução de IDs com fallback em 3 níveis** (`encaminharServico`), para cada um dos 4 elementos críticos (aba Fases pós-Editar, botão Encaminhar, botão Salvar Fase, botão Salvar Detalhes):
1. Testa, em ordem, uma lista de IDs conhecidos de deploys anteriores (`TAB_FASES_CONTAINER_IDS`, `BTN_ENCAMINHAR_IDS`, `BTN_SALVAR_FASE_IDS`, `BTN_SALVAR_DETALHES_IDS`).
2. Se nenhum estiver visível, cai para um fallback genérico por **DOM/texto** (ex: link com texto "Fases" dentro de `.ui-tabview-nav`; botão habilitado com texto `/encaminhar|salvar/i` excluindo `/cancelar|fechar/i`; para Salvar Fase, um 2° fallback pega o último botão de ação do dialog).
3. Quando o fallback é usado, `console.warn` imprime o ID real encontrado (e, para o dialog de Encaminhar, lista todos os `.ui-button` presentes) — **copiar o ID logado para a respectiva lista `*_IDS` no topo do arquivo** para fixar o seletor no próximo deploy.
4. Se nem o fallback encontrar o elemento, lança `Error` (interrompe o serviço, não o loop).

**Retomada isolada / batch:** `node src/web/auto-protocolar.js etapa11` — ver 3.11.

---

### 3.10 Recorder (`recorder.js`)

Utilitário de desenvolvimento para mapear seletores JSF/PrimeFaces:
- `prepararPagina()` — abre o SIGAD já logado com filtro `Cadastro`.
- Injeta spy JS (`click`, `change`, `input`) na aba ESAJ; re-injeta após `framenavigated`.
- Após 10s de inatividade, salva em `data/recording.json` e fecha.

---

### 3.11 Modo `etapa11` — dois submodos

`mainEtapa11()` decide o submodo pelos arquivos presentes em `data/` (checados nessa ordem):

**Batch (`data/encaminhar.json` existe):**
- Lê um array `[{ "servico": "XX.XXX", "observacao": "...", "subfase"? }]` (subfase default `AGUARDAR PROTOCOLO`).
- Para cada item: abre o serviço (`abrirServicoESigad`), chama `encaminharServico`, remove o item processado do array e regrava `encaminhar.json` (retomável em caso de falha no meio do batch) — volta para a home do SIGAD entre itens.
- Ao terminar todos, apaga `data/encaminhar.json`.

**Retomada (sem batch, `data/extracao-protocolo.json` existe):**
- Lê `servico` e `fases.observacao` da última extração do fluxo completo, abre o dialog do serviço, navega para Dados Básicos e chama `encaminharServico` com subfase default.

Se nenhum dos dois arquivos existir, lança erro explicando como criar cada um.

---

### 3.12 `teste-partes.js` — utilitário de diagnóstico

Script standalone (não integrado ao fluxo principal) para validar `extrairPartesDoESAJ`/`extrairCabecalhoDoESAJ` contra processos reais sem depender do SIGAD:
- Edite o array `PROCESSOS_ALVO` no topo do arquivo com números de processo (`1234567-89.2024.8.12.0001`).
- Abre o ESAJ diretamente (`cpopg5`), faz login por certificado se necessário, preenche os campos de busca (`#numeroDigitoAnoUnificado` / `#foroNumeroUnificado`) com retry ×3 para reCAPTCHA, e extrai partes + cabeçalho de cada processo.
- Salva o resultado consolidado em `data/teste-partes-resultado.json`.
- Mantém o browser aberto ao final para inspeção manual.

> Contém uma cópia própria de `classificarRoleESAJ`/`extrairPartesDoESAJ`/`extrairCabecalhoDoESAJ` — ao alterar a lógica de extração em `auto-protocolar.js`, replicar a mudança aqui também.

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
| `encaminhar.json` | manual (entrada) | Lista `[{ servico, observacao, subfase? }]` para o submodo batch de `etapa11`; consumido item a item e apagado ao fim (ver 3.11) |
| `recording.json` | `recorder.js` | Interações + navegações gravadas na guia ESAJ |
| `teste-partes-resultado.json` | `teste-partes.js` | Partes + cabeçalho extraídos para cada processo em `PROCESSOS_ALVO` |
| `chrome-profile/` | `crawler.js` (`abrirBrowser`) | Perfil persistente do Chromium — clone do perfil real do Chrome do usuário (certificado, extensões, login Google) |
| `debug_<label>.png` / `.json` | `crawler.js` (`debugPagina`) | Screenshot + IDs visíveis na página, capturados em timeouts de seletor (ex: filtro Situação) para diagnóstico |

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

**Etapa 11 — Encaminhar (cascata de IDs conhecidos + fallback por DOM/texto, ver 3.9):**
- Botão Editar: `[id="formDlgVerServico"] span.ui-button-text:has-text("Editar")`
- Aba Fases pós-Editar (`TAB_FASES_CONTAINER_IDS`): `j_idt474` → `j_idt436` → `j_idt438`
- Botão Encaminhar (`BTN_ENCAMINHAR_IDS`): `formServico:j_idt474:j_idt545` → `formServico:j_idt436:j_idt507` → `formServico:j_idt438:j_idt509`
- Autocomplete Nome: `formDlgEnviarServico:inputUsuario_input`
- Subfase: `formDlgEnviarServico:inputSubfase_label` / `inputSubfase_panel`
- Observação: `formDlgEnviarServico:inputObsFase`
- Salvar Fase (`BTN_SALVAR_FASE_IDS`): `formDlgEnviarServico:j_idt714` → `j_idt750` → `j_idt712`
- Salvar Detalhes (`BTN_SALVAR_DETALHES_IDS`): `formServico:j_idt471` → `formServico:j_idt433`

> IDs `j_idt*` podem mudar entre deploys do SIGAD. Quando o fallback por DOM/texto é acionado, o `console.warn` mostra o ID real — adicionar esse ID à respectiva lista `*_IDS` no topo de `auto-protocolar.js` para fixar o seletor.

---

## 7. Problemas Conhecidos

- **IDs dinâmicos JSF:** mudam entre deploys. Manter fallbacks nas listas `*_IDS`/objeto `SEL` de `auto-protocolar.js` (ver 3.9).
- **reCAPTCHA no ESAJ:** retry ×3 (2s entre tentativas). Após 3 falhas, lança erro (interrompe o serviço atual).
- **Timeout AJAX:** a fila PrimeFaces pode não esvaziar em 15s em conexões lentas.
- **Notificação de divergência (Etapa 7.2):** código comentado — requer `GMAIL_USUARIO`/`GMAIL_APP_PASSWORD`. Enquanto pendente, divergências (Etapas 3, 5, 7) apenas encaminham o serviço com subfase `PROTOCOLAR` sem alertar ninguém.
- **`main.js` / `npm run pre`:** stub legado quebrado — importa `login()` de `auth.js`, que hoje exporta `fazerLogin`/`loadSession`. Não usar até ser corrigido ou removido.
- **Perfil Chrome compartilhado:** `abrirBrowser()` mata todo processo `chrome.exe` em execução ao iniciar (ver 3.1) — o usuário não pode ter o Chrome normal aberto durante a automação.

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

# Só Encaminhar — batch (data/encaminhar.json) ou retomada após falha na Etapa 11 (ver 3.11)
node src/web/auto-protocolar.js etapa11

# Gravador de interações (desenvolvimento — mapear seletores)
node src/web/recorder.js
npm run recorder

# Teste isolado de extração de partes do ESAJ (edite PROCESSOS_ALVO antes)
node src/web/teste-partes.js
npm run teste-partes
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
| `[partes]` / `[processo]` / `[teste-partes]` | `src/web/teste-partes.js` |
| `[sincronizador]` | `src/server/sincronizador.js` |
