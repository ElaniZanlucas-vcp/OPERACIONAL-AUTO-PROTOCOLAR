# Automação Operacional — SIGAD

Automação do fluxo de entrada de serviços periciais no SIGAD (sistema judicial interno), reduzindo trabalho manual repetitivo de triagem, classificação e registro de novos processos.

---

## 1. Fluxograma

A rotina executa **duas vezes por dia** (08:00 e 14:00, dias úteis).

```
[INÍCIO DA ROTINA] (08:00 / 14:00)
│
├─ [1. Login] ────────────────────────── auth.js                    ✔
├─ [2. Acessar Rota + Filtrar] ────────── crawler.js                ✔
│
│ ┌──────────────────────────────────────────────────────────────────┐
│ │  LOOP por serviço em pending.json                                │
│ │                                                                  │
│ │  [0. Baixar processo — ESAJ] ─── clicarAbaProcesso()  ✔ simulado│
│ │  [1. Resumo Gemini] ───────────────────────────────── ⚙ stub    │
│ │      └─ preenche Notas com resumo (detalhe do serviço)           │
│ │  [2. Extrair Partes das Notas] ─── parsearPartesDeNotas() ✔     │
│ │  [3. Lançar skills em background] ─────────────────── ✔         │
│ │      ├─ skill-tipo-pericia ───────────────────────── ✔          │
│ │      └─ skill-proposta-honorarios ────────────────── ✔          │
│ │  [4. Preencher Partes] ──────────────────────────── ✔ simulado  │
│ │  [5. Add Evento (Entrega Proposta)] ──────────────── ✔ simulado  │
│ │  [6. Await skills → preencher Notas com classificação] ── ✔     │
│ │  [7. Iterar] ────────────────────────────────────────── ✔       │
│ └──────────────────────────────────────────────────────────────────┘
│
└─ [Limpeza .json] ─────────────────────── pending.json + partes  ✔

[FIM DA ROTINA]
```

**Legenda:** `✔` implementado · `✔ simulado` funcional sem salvar · `⚙` stub · `✘` não iniciado

**Paralelismo no loop:** As skills (passos 3) rodam como processo filho assíncrono (`spawn`) enquanto o browser executa Partes e Evento. O resultado é aguardado apenas antes de preencher Notas (passo 6).

---

## 2. Scripts

| Script | Responsabilidade |
|--------|-----------------|
| `main.js` | Orquestrador — fases `pre` e `post`, separa IA de scripts puros |
| `src/web/auth.js` | Login no SIGAD, salva cookies em `data/auth.json` |
| `src/web/crawler.js` | Filtra tabela, extrai todas as páginas → `data/resultados.json` |
| `src/web/api-site.js` | Loop principal: ESAJ, skills, Notas, Partes, Evento |
| `src/web/recorder.js` | Grava interações na guia de processo para mapear seletores |
| `src/local/manipulador_word.py` | Preenche template `.docx` (stub) |
| `src/server/sincronizador.js` | Upload SFTP ao servidor (stub) |
| `.claudeskills/processar-dados.md` | Instrução de orquestração para o Claude Code |
| `.claudeskills/skill-tipo-pericia/` | Classifica o tipo de perícia (~70 tipos, 9 grupos) |
| `.claudeskills/skill-proposta-honorarios/` | Calcula faixa de honorários via matriz |

---

## 3. Fluxos Detalhados

### 3.1 Login e Sessão (`auth.js` + `crawler.js`)

- `auth.js`: lê `SIGAD_USUARIO` / `SIGAD_SENHA` do `.env`, preenche o formulário de login, confirma pela presença do item `"Painéis"` no menu e salva cookies em `data/auth.json`.
- `crawler.js / garantirSessao()`: abre o SIGAD e reusa cookies existentes; refaz o login automaticamente se a sessão expirou.
- `crawler.js / prepararPagina()`: versão reutilizável que retorna `{ browser, context, page }` já autenticado e com filtro `Situação = Cadastro` aplicado — ponto de entrada correto para `api-site.js` e `recorder.js`.

**Workaround técnico:** PrimeFaces mantém conexões keepalive que bloqueiam `networkidle`. `aguardarAjax()` espera a fila interna do PF esvaziar antes de prosseguir.

---

### 3.2 Extração de Dados (`crawler.js`)

- Aplica filtro `Situação = Cadastro` via `SelectOneMenu` PrimeFaces.
- Itera pelo paginador (`ui-paginator-next`) até não haver próxima página.
- Normaliza datas: `"09/jun./2026"` → `"09/06/2026"`.
- Extrai por linha: `{ servico, teor, disponibilizacao, processo }`.
  - `processo` vem do `href` ESAJ da coluna Processo, via query param `dadosConsulta.valorConsultaNuUnificado`.
- Salva em `data/resultados.json`.

---

### 3.3 ESAJ — Consulta de Processo (`api-site.js / clicarAbaProcesso`)

Para cada serviço, o SIGAD tem um link que abre o ESAJ (`esaj.tjms.jus.br`) em nova aba.

**Formato do n° de processo:** `1111111-11.1111.8.12.0000`
- `#numeroDigitoAnoUnificado` ← `1111111-11.1111`
- `#foroNumeroUnificado` ← `0000`

**Fluxo:**
1. Abre nova aba via click no link da coluna Processo da tabela SIGAD.
2. Verifica se os campos estão vazios; se sim, preenche via `parsearNumeroProcesso()`.
3. Clica em Consultar. **Retry ×3** (2s entre tentativas) caso reCAPTCHA bloqueie (`#linkPasta` não aparece). Após 3 falhas, fecha a aba e continua o fluxo.
4. Clica em `#linkPasta` ("Visualizar autos").
5. Aguarda 3s e fecha a aba.

---

### 3.4 Notas — Leitura e Preenchimento (`api-site.js`)

Toda a interação com Notas ocorre na **página de detalhe do serviço** (`/sigad/usuario/servico/index.xhtml?numero=XXXX`), aba Notas — nunca no dialog da lista.

**`abrirNotasDetalhe(page)`** — clica na aba Notas, aguarda o editor Quill (`div.ql-editor` dentro de `[id="formServico"]`) ficar visível e com conteúdo.

**Fluxo por serviço:**

1. **Leitura inicial** — `qlEditor.innerText()` captura o texto completo das Notas (`textoNotas`).
2. **Resumo Gemini** *(stub)* — quando `pdfPath` disponível, chama `gerarResumoGemini(pdfPath)` e injeta o resumo nas Notas via `_injetarERestaurar` (simulação — restaura após 10s).
3. **Extração de Partes** — `parsearPartesDeNotas(textoNotas)` sobre o texto original capturado no passo 1.
4. **Preenchimento final (após Evento)** — após aguardar o resultado das skills, clica novamente na aba Notas (já em Detalhes) e injeta a classificação + honorários via `_injetarERestaurar`.

**`_injetarERestaurar(page, servico, html, delayMs, tag, selector)`** — injeta HTML no editor Quill, aguarda `delayMs` ms e restaura o conteúdo original. Em modo simulação nenhum dado é salvo.

**Formato injetado (classificação):**
```
Classificação da Perícia:
- Tipo de perícia:          [CONTABIL]
    - Justificativa:        ...
- Proposta de honorários:
        - Natureza:         TABELA_CJF
        - Unidade:          folha
        - Quantidade:       ...
        - Faixa:            ...
        - Valor mínimo:     ...
        - Valor máximo:     ...
        - Justificativa:    ...
```

---

### 3.5 Skills de IA — Execução em Background (`api-site.js`)

As skills são invocadas via **Claude CLI assíncrono** (`spawn`) para não bloquear o browser enquanto Partes e Evento são processados.

**Constante `USAR_SKILLS`** (linha 29 de `api-site.js`):
- `false` — usa mock de `data/resultado-pericia.json` (sem chamar o Claude).
- `true` — executa `executarSkillsAsync()` em background real.

**`executarSkillsAsync(servico, resumo)`** — encadeia as duas skills:

1. **`skill-tipo-pericia`** — recebe `{ id, resumoProcesso }`, retorna o tipo de perícia da lista fechada em `tipo_pericia.md` (~70 tipos, 9 grupos). Anti-alucinação: escopo fechado, emite `ERRO:` se não houver match.

2. **`skill-proposta-honorarios`** — recebe `{ id, tipoPericia, resumoProcesso }`, retorna faixa de honorários com base em `matriz_honorarios.md`. Saída: `{ natureza_tabela, unidade_medida, quantidade_extraida, faixa_enquadramento, valor_minimo_proposto, valor_maximo_proposto, justificativa_extracao }`.

O `await skillsPromise` ocorre após o Evento, antes de preencher Notas. Se as skills terminaram durante Partes + Evento, o await é instantâneo.

---

### 3.6 Preenchimento de Partes (`api-site.js`)

**Parser `parsearPartesDeNotas(textoNotas)`** — extrai partes e advogados do campo Notas antes de processar cada serviço:
- Detecta a seção pela marcação `"Relação de Todas as Partes Envolvidas"` (busca com `indexOf` + NFC para evitar falha do flag `i` com caracteres acentuados).
- Detecta blocos por linha `Participação:` (ignora `Representante` e variantes).
- Extrai `Nome`, `CPF/CNPJ`, `OAB` com regex: `OAB[\/\s]+([A-Z]{2})[^0-9]*(\d[\d.]*)` (suporta `n°`, `nº`, `n.` independente de encoding).
- Cobre formas femininas e parentéticas: `^Advogad[oa]s?[^:]*:`.
- Múltiplos advogados na mesma linha separados por ` - ` são extraídos via split.
- Salva em `data/partes-temporarias.json` — deletado ao fim de cada serviço por `limparPartes()`.

**`processarUmaParte(page, parte, numeroURL)`:**
1. Abre dialog Nova Parte, triple-click no campo antes de digitar (estado PrimeFaces entre aberturas).
2. `pressSequentially()` no autocomplete nome (dispara AJAX do PrimeFaces).
3. Se encontrado → seleciona resultado + escolhe participação → processa advogados.
4. Se não encontrado → Cadastro: navega para `pessoa/index.xhtml`, preenche filtros Nome + CPF, retorna à aba Partes.

**`processarUmAdvogado(page, adv, participacaoSigad, numeroURL)`:**
- Mesmo fluxo do autocomplete.
- Se não encontrado → Cadastro com OAB: seleciona rádio "OAB" (valor `3`), preenche número + UF + nome.
- Ao final, retorna à aba Partes do serviço via `page.goto()`.

**[SIMULAÇÃO ATIVA]:** dialogs são fechados sem salvar. UI de adição de advogado à parte ainda não mapeada — logado com `[SIMULAÇÃO - UI de advogado não mapeada]`.

---

### 3.7 Criação de Evento (`api-site.js / criarEventoEntregaProposta`)

**Cálculo de prazo:**
- `Dias_corridos` = disponibilização + 8 dias corridos (9 contando o inicial).
- `Data_Prazo` = `Dias_corridos` + 5 dias úteis.
- Ex: disponibilização `08/06/2026` → corridos `16/06` → prazo `23/06`.

**Fluxo:**
1. Já na página de detalhe (`…/servico/index.xhtml?numero=<SERVICO>`), clica na aba Evento.
2. Verifica se a tabela já tem eventos:
   - **Eventos existentes:** loga "Pulando criação de evento" e prossegue para o preenchimento de Notas.
   - **Sem eventos:** clica em Novo Evento → preenche `Tipo = ENTREGA PROPOSTA`, `Data Prevista`, `Data Prazo`, `Observação = teor`.
3. Em ambos os casos, após o Evento as skills são aguardadas e Notas é preenchida antes de avançar.

**[SIMULAÇÃO ATIVA]:** o formulário é preenchido mas não salvo — dialog fechado via `PF('DlgEventoServico').hide()`.

---

### 3.8 Controle de Loop e Retomada

- Ao iniciar, coleta todos os serviços e salva em `data/pending.json`.
- A cada serviço concluído, remove-o do arquivo.
- Se o script for interrompido, retoma de onde parou na próxima execução.
- `pending.json` é deletado no bloco `finally` ao final do loop (mesmo em caso de erro).
- `partes-temporarias.json` é deletado por `limparPartes()` ao final de cada serviço (após o preenchimento de Notas).

---

### 3.9 Recorder (`recorder.js`)

Utilitário de desenvolvimento para mapear seletores JSF/PrimeFaces desconhecidos:

- Usa `prepararPagina()` — abre o SIGAD já logado com filtro `Cadastro`.
- `abrirGuiaProcesso()` — localiza a coluna Processo (`j_idt331`/`j_idt367`) e clica no link da primeira linha, aguardando a nova aba ESAJ abrir.
- Injeta spy JS (`click`, `change`, `input`) na nova aba.
- Re-injeta o spy após navegações internas (`framenavigated`).
- Após `10s` de inatividade, salva em `data/recording.json` (inclui interações + navegações + estrutura de tabela) e fecha o browser.

---

## 4. Stubs Pendentes

| Módulo | Status | Pendência |
|--------|--------|-----------|
| `src/local/manipulador_word.py` | ⚙ stub | Implementação `python-docx` |
| `src/server/sincronizador.js` | ⚙ stub | Credenciais SSH/SFTP |
| Resumo Gemini | ⚙ stub | Integração com Gemini API (`src/local/resumo_gemini.py`) |
| UI de advogado no SIGAD | ✘ | Mapeamento via `recorder.js` (vínculo advogado↔parte) |
| Agendamento `rotina-diaria.json` | ✘ comentado | Ativar após todos os stubs |

---

## 5. Arquivos em `data/`

| Arquivo | Gerado por | Conteúdo |
|---------|-----------|----------|
| `auth.json` | `auth.js` | Cookies de sessão do SIGAD (mantido entre execuções) |
| `resultados.json` | `crawler.js` | `[{ id, servico, teor, disponibilizacao, processo }]` |
| `pending.json` | `api-site.js` | Serviços não processados; deletado ao final do loop |
| `partes-temporarias.json` | `api-site.js` | `[{ nome, documento, participacao, advogados:[{nome,documento}] }]`; deletado por `limparPartes()` ao fim de cada serviço |
| `resultado-pericia.json` | `api-site.js` | Resultado acumulado das skills por serviço; usado como mock quando `USAR_SKILLS=false` |
| `recording.json` | `recorder.js` | Interações + navegações gravadas na guia ESAJ |
| `debug_*.png` / `debug_*.json` | `crawler.js` | Diagnósticos gerados em timeout |

---

## 6. IDs PrimeFaces Confirmados (deploy atual)

**Tabela SIGAD (`crawler.js` / `api-site.js`):**
- Filtro Situação: `formServico:tabela:j_idt381_label` / `j_idt381_panel`
- Coluna Teor da Intimação: `formServico:tabela:j_idt373`
- Coluna Disponibilização: `formServico:tabela:j_idt357`
- Coluna Processo (link ESAJ): `formServico:tabela:j_idt331` ou `j_idt367`

**Aba Partes (`api-site.js`):**
- Tabela de partes: `formServico:j_idt472:tabListaParte`
- Autocomplete Nome: `formServicoParte:inputNomeParte_input` / painel: `formServicoParte:inputNomeParte_panel`
- Autocomplete Participação: `formServicoParte:inputTipoParte_input` / painel: `formServicoParte:inputTipoParte_panel`
- Ícone dropdown Participação: `.ui-icon-triangle-1-s` dentro de `[id="formServicoParte:inputTipoParte"]`
- Filtros Pessoas: `formLista:j_idt312:inputNome` / `formLista:j_idt312:inputCPF`

---

## 7. Problemas Conhecidos

- **IDs dinâmicos JSF:** `j_idt345` pode mudar entre deploys da aplicação, quebrando seletores.
- **reCAPTCHA no ESAJ:** `clicarAbaProcesso` tem retry ×3 (2s entre tentativas). Se o bloqueio persistir, a aba é fechada e o serviço continua sem consulta ESAJ.
- **Sessão expirada no loop:** `garantirSessao()` detecta expiração apenas na abertura; uma expiração durante o loop quebra a iteração.
- **skill-tipo-pericia imprecisa:** pode não associar corretamente para perícias mistas ou atípicas.
- **Timeout AJAX:** a fila PrimeFaces pode não esvaziar em 15s em conexões lentas.
- **UI de advogado não mapeada:** `processarUmAdvogado` navega para Cadastro mas não preenche o vínculo advogado↔parte no SIGAD.

---

## 8. Instalação e Execução

**Pré-requisitos:** Node.js ≥ 18 · Python ≥ 3.9 (quando `manipulador_word.py` for ativado)

```bash
npm install
npx playwright install chromium
```

**`.env` na raiz:**
```env
SIGAD_USUARIO=seu_usuario
SIGAD_SENHA=sua_senha
```

**Comandos:**
```bash
# Fase PRE: login + extração
node main.js pre

# Loop completo standalone
node src/web/api-site.js

# Gravador de interações na guia ESAJ (desenvolvimento)
node src/web/recorder.js

# Python — geração de .docx (quando implementado)
.venv\Scripts\python src/local/manipulador_word.py <template.docx> <output.docx>
```

**Para ativar skills reais:** editar linha 29 de `src/web/api-site.js`:
```js
const USAR_SKILLS = true; // false = mock de resultado-pericia.json
```

---

## 9. Prefixos de Log

| Prefixo | Origem |
|---------|--------|
| `[auth]` | `src/web/auth.js` |
| `[crawler]` | `src/web/crawler.js` |
| `[api-site]` | `src/web/api-site.js` |
| `[skill]` | `src/web/api-site.js` — chamadas às skills |
| `[gemini]` | `src/web/api-site.js` — integração Gemini |
| `[recorder]` | `src/web/recorder.js` |
| `[word]` | `src/local/manipulador_word.py` |
| `[sincronizador]` | `src/server/sincronizador.js` |
| `[main]` | `main.js` |
