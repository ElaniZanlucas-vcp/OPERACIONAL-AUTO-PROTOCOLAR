// auto-protocolar.js — Etapas 2-4 e 11: Fases → Documentos → Dados Básicos → ESAJ → Encaminhar

'use strict';

const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
const { abrirBrowser } = require('./crawler');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const SIGAD_INICIO_URL  = 'https://sistemas.vcpericia.com.br/sigad/inicio/index.xhtml';
const EXTRACAO_FILE     = path.resolve(__dirname, '../../data/extracao-protocolo.json');
const TRABALHOS_FINAIS  = process.env.TRABALHOS_FINAIS

const ENCAMINHAR_NOME = 'Dayane Franco Alves';

// ── Seletores confirmados via recorder ───────────────────────────────────────

const SEL = {
  // Etapa 1 — tabela de serviços e item clicável
  SERVICO_LINHAS: '[id="formServico:tabela_data"] tr',
  SERVICO_ITEM:   'span.Fs14.FontSemiBold',

  // Tabs do dialog formDlgVerServico (confirmadas: fluxo-protocolar + encaminhar)
  TAB_FASES: '[id="formDlgVerServico:tabViewEvento"] a:has-text("Fases")',
  TAB_DOCS:  '[id="formDlgVerServico:tabViewEvento"] a:has-text("Documentos")',
  TAB_DADOS: '[id="formDlgVerServico:tabViewEvento"] a:has-text("Dados Básicos")',

  // Linhas das tabelas de fases e documentos (vista)
  FASES_LINHAS: '[id="formDlgVerServico:tabViewEvento:tabListaFase_data"] tr',
  DOCS_LINHAS:  '[id="formDlgVerServico:tabViewEvento:tabListaDocumento_data"] tr',

  // Etapa 11 — Encaminhar (confirmados via recorder "encaminhar")
  // Após "Editar", o dialog fecha e o formulário abre em formServico:j_idt474
  BTN_EDITAR:       '[id="formDlgVerServico"] span.ui-button-text:has-text("Editar")',
  TAB_FASES_EDIT:   '[id="formServico:j_idt474"] a:has-text("Fases")',
  BTN_ENCAMINHAR:   '[id="formServico:j_idt474:j_idt545"]',
  DLG_ENCAMINHAR:   '[id="formDlgEnviarServico"]',
  NOME_INPUT:       '[id="formDlgEnviarServico:inputUsuario_input"]',
  NOME_PANEL:       '[id="formDlgEnviarServico:inputUsuario_panel"]',
  SUBFASE_LABEL:    '[id="formDlgEnviarServico:inputSubfase_label"]',
  SUBFASE_PANEL:    '[id="formDlgEnviarServico:inputSubfase_panel"]',
  OBS_FASE:         '[id="formDlgEnviarServico:inputObsFase"]',
};

// ── Helpers Node.js ───────────────────────────────────────────────────────────

async function aguardarAjax(page) {
  await page.waitForFunction(
    () => typeof window.PrimeFaces === 'undefined' || window.PrimeFaces.ajax.Queue.isEmpty(),
    { timeout: 15000 }
  ).catch(() => {});
}

// "doc1 // doc2" → ['doc1', 'doc2']  (doc2 é sempre Alvará quando presente)
function parsearDocsObservacao(observacao) {
  return observacao.split('//').map(d => d.trim()).filter(Boolean);
}

function salvarExtracao(dados) {
  fs.writeFileSync(EXTRACAO_FILE, JSON.stringify(dados, null, 2), 'utf-8');
  console.log(`[auto-protocolar] Extração salva → ${EXTRACAO_FILE}`);
}

// ── Etapa 2: Acessar Fases ───────────────────────────────────────────────────

async function extrairFases(page) {
  console.log('[etapa-2] Clicando na aba Fases...');
  await page.locator(SEL.TAB_FASES).click();
  await aguardarAjax(page);

  const dados = await page.evaluate((seletorLinhas) => {
    // Células PrimeFaces responsivas têm <span class="ui-column-title">Label</span>Valor.
    // Remove o título e a data ("dd/mmm./aaaa...") que eventualmente acompanha o valor.
    function valorCelula(td) {
      if (!td) return '';
      const clone = td.cloneNode(true);
      clone.querySelectorAll('.ui-column-title').forEach(s => s.remove());
      return clone.textContent
        .replace(/\s*\d{1,2}\/\w+\.?\s*\/\s*\d{4}.*/s, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function celulaPorTitulo(row, titulo) {
      for (const td of row.querySelectorAll('td')) {
        const t = td.querySelector('.ui-column-title');
        if (t && t.textContent.trim() === titulo) return td;
      }
      return null;
    }

    const linhas = [...document.querySelectorAll(seletorLinhas)];
    if (linhas.length === 0) return null;

    const row = linhas[0]; // primeira linha = mais recente / "Encaminhado por"
    return {
      fase:       valorCelula(celulaPorTitulo(row, 'Fase')),
      subfase:    valorCelula(celulaPorTitulo(row, 'Subfase')),
      observacao: valorCelula(celulaPorTitulo(row, 'Observação')),
    };
  }, SEL.FASES_LINHAS);

  if (!dados || !dados.fase) {
    console.warn('[etapa-2] Nenhuma fase encontrada.');
    return null;
  }

  const documentosEsperados = parsearDocsObservacao(dados.observacao);
  const temAlvara = documentosEsperados.length > 1;

  console.log(`[etapa-2] Fase: "${dados.fase}" | Subfase: "${dados.subfase}"`);
  console.log(`[etapa-2] Observação: "${dados.observacao}"`);
  console.log(`[etapa-2] Docs esperados: ${JSON.stringify(documentosEsperados)}${temAlvara ? ' — contém Alvará' : ''}`);

  return { ...dados, documentosEsperados, temAlvara };
}

// ── Etapa 3: Acessar Documentos ──────────────────────────────────────────────

async function extrairDocumentos(page, temAlvara) {
  console.log('[etapa-3] Clicando na aba Documentos...');
  await page.locator(SEL.TAB_DOCS).click();
  await aguardarAjax(page);

  const qtd = temAlvara ? 2 : 1;

  const documentos = await page.evaluate(({ seletorLinhas, qtd }) => {
    function valorCelula(td) {
      if (!td) return '';
      const clone = td.cloneNode(true);
      clone.querySelectorAll('.ui-column-title').forEach(s => s.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    function celulaPorTitulo(row, titulo) {
      for (const td of row.querySelectorAll('td')) {
        const t = td.querySelector('.ui-column-title');
        if (t && t.textContent.trim() === titulo) return td;
      }
      return null;
    }

    return [...document.querySelectorAll(seletorLinhas)]
      .slice(0, qtd)
      .map(row => valorCelula(celulaPorTitulo(row, 'Documento')));
  }, { seletorLinhas: SEL.DOCS_LINHAS, qtd });

  console.log(`[etapa-3] Docs encontrados (${documentos.length}): ${JSON.stringify(documentos)}`);
  return documentos;
}

// doc1 // doc2 da Fase = doc1, doc2 por ordem de mais recente nos Documentos
function conferirDocumentos(esperados, encontrados) {
  if (esperados.length !== encontrados.length) return false;
  return esperados.every((esp, i) =>
    encontrados[i]?.toLowerCase().includes(esp.toLowerCase())
  );
}

// ── Etapa 4: Dados Básicos → abrir processo no ESAJ ──────────────────────────

async function abrirProcessoNoESAJ(page, context) {
  console.log('[etapa-4] Clicando na aba Dados Básicos...');
  await page.locator(SEL.TAB_DADOS).click();
  await aguardarAjax(page);

  // Processo: span sem ID/classe — identificado pelo formato do número
  const linkProcesso = page
    .locator('[id="formDlgVerServico"] span')
    .filter({ hasText: /\d{7}-\d{2}\.\d{4}\.\d+\.\d+\.\d{4}/ })
    .first();

  console.log('[etapa-4] Clicando no processo...');
  const [esajAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    linkProcesso.click(),
  ]);

  await esajAba.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  console.log(`[etapa-4] ESAJ aberto: ${esajAba.url()}`);
  return esajAba;
}

// ── Etapa 5: Localizar pasta do serviço no servidor ──────────────────────────

function localizarPastaServico(servico) {
  // "29.872" → "29872"
  const numero = servico.replace(/\./g, '');
  const pastaServico = path.join(TRABALHOS_FINAIS, numero);

  if (!fs.existsSync(pastaServico)) {
    throw new Error(`[etapa-5] Pasta não encontrada: ${pastaServico}`);
  }

  const subpastas = fs.readdirSync(pastaServico, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const fullPath = path.join(pastaServico, e.name);
      return { name: e.name, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (subpastas.length === 0) {
    throw new Error(`[etapa-5] Nenhuma subpasta encontrada em: ${pastaServico}`);
  }

  const maisRecente = subpastas[0];
  console.log(`[etapa-5] Pasta serviço:   ${pastaServico}`);
  console.log(`[etapa-5] Subpasta recente: ${maisRecente.path}`);
  return { pastaServico, pastaRecente: maisRecente.path };
}

// ── Etapa 6: Extrair cabeçalho da 1ª página do PDF ───────────────────────────

async function extrairCabecalhoDocumento(pastaRecente, nomeDocumento) {
  const nomeLower = nomeDocumento.toLowerCase();
  const arquivo = fs.readdirSync(pastaRecente).find(f =>
    f.toLowerCase().endsWith('.pdf') && f.toLowerCase().includes(nomeLower)
  );

  if (!arquivo) {
    throw new Error(`[etapa-6] PDF não encontrado para "${nomeDocumento}" em ${pastaRecente}`);
  }

  const caminho = path.join(pastaRecente, arquivo);
  console.log(`[etapa-6] Lendo PDF: ${caminho}`);

  const buffer = fs.readFileSync(caminho);
  const { text } = await pdfParse(buffer, { max: 1 }); // apenas 1ª página

  const varaForo = text.match(/AO JU[IÍ]ZO DA (.+?) DA COMARCA DE ([^\n]+)/i);
  const autos    = text.match(/AUTOS[:\s]+([^\n]+)/i);
  const acao     = text.match(/A[ÇC][ÃA]O[:\s]+([^\n]+)/i);
  const reqte    = text.match(/REQTE[:\s]+([^\n]+)/i);
  const reqdo    = text.match(/REQDO[:\s]+([^\n]+)/i);

  const cabecalho = {
    vara:     varaForo?.[1]?.trim()  ?? null,
    foro:     varaForo?.[2]?.trim()  ?? null,
    processo: autos?.[1]?.trim()     ?? null,
    classe:   acao?.[1]?.trim()      ?? null,
    reqte:    reqte?.[1]?.trim()     ?? null,
    reqdo:    reqdo?.[1]?.trim()     ?? null,
    arquivo,
  };

  console.log('[etapa-6] Cabeçalho:', JSON.stringify(cabecalho, null, 2));
  return cabecalho;
}

// ── Etapa 11: Encaminhar ──────────────────────────────────────────────────────

async function encaminharServico(page, { nome, observacao }) {
  // Dialog na aba Dados Básicos → "Editar" abre formulário completo em formServico:j_idt474
  console.log('[etapa-11] Clicando em Editar...');
  await page.locator(SEL.BTN_EDITAR).click();
  await aguardarAjax(page);

  // Após Editar, as abas estão em formServico:j_idt474 (não mais no dialog)
  console.log('[etapa-11] Clicando na aba Fases...');
  await page.locator(SEL.TAB_FASES_EDIT).click();
  await aguardarAjax(page);

  // Abre dialog de encaminhamento
  console.log('[etapa-11] Clicando em Encaminhar...');
  await page.locator(SEL.BTN_ENCAMINHAR).click();
  await aguardarAjax(page);
  await page.locator(SEL.DLG_ENCAMINHAR).waitFor({ state: 'visible', timeout: 10000 });

  // Nome — p:autoComplete (triple-click + pressSequentially para disparar busca AJAX)
  console.log(`[etapa-11] Preenchendo Nome: "${nome}"...`);
  const nomeInput = page.locator(SEL.NOME_INPUT);
  await nomeInput.click({ clickCount: 3 });
  await nomeInput.pressSequentially(nome, { delay: 80 });
  const nomePanel = page.locator(SEL.NOME_PANEL);
  await nomePanel.locator('li:not(.ui-autocomplete-empty-message)').first()
    .waitFor({ state: 'visible', timeout: 8000 });
  await nomePanel.locator('li:not(.ui-autocomplete-empty-message)').first().click();
  await aguardarAjax(page);

  // Subfase — SelectOneMenu "AGUARDAR PROTOCOLO"
  console.log('[etapa-11] Selecionando Subfase: AGUARDAR PROTOCOLO...');
  await page.locator(SEL.SUBFASE_LABEL).click();
  const subfasePanel = page.locator(SEL.SUBFASE_PANEL);
  await subfasePanel.waitFor({ state: 'visible', timeout: 5000 });
  await subfasePanel.locator('li').filter({ hasText: /AGUARDAR PROTOCOLO/i }).click();
  await aguardarAjax(page);

  // Observação — mesma da Fase (textarea)
  console.log(`[etapa-11] Preenchendo Observação: "${observacao}"...`);
  const obsField = page.locator(SEL.OBS_FASE);
  await obsField.click({ clickCount: 3 });
  await obsField.fill(observacao);

  // [SIMULAÇÃO] — não clicar no botão final de Encaminhar/Salvar
  console.log('[etapa-11][SIMULAÇÃO] Formulário preenchido — encerrado sem salvar.');
}

// ── Fluxo por serviço ─────────────────────────────────────────────────────────

async function processarServico(page, context) {
  // Etapa 1 — Lê o Serviço e abre o dialog
  const primeiraLinha = page.locator(SEL.SERVICO_LINHAS).first();
  const servico = await primeiraLinha.locator(SEL.SERVICO_ITEM).textContent().then(t => t.trim());
  await primeiraLinha.locator(SEL.SERVICO_ITEM).click();
  await aguardarAjax(page);
  await page.locator('[id="formDlgVerServico"]').waitFor({ state: 'visible', timeout: 10000 });

  const extracao = { servico };

  // Etapa 2 — Fases
  const fases = await extrairFases(page);
  if (!fases) return { ok: false, motivo: 'sem fases' };
  extracao.fases = fases;
  salvarExtracao(extracao);

  // Etapa 3 — Documentos
  const documentosEncontrados = await extrairDocumentos(page, fases.temAlvara);
  const confere = conferirDocumentos(fases.documentosEsperados, documentosEncontrados);
  extracao.documentos = { encontrados: documentosEncontrados, confere };
  salvarExtracao(extracao);

  if (!confere) {
    console.warn('[etapa-3] Documentos não conferem com a Fase — encerrando serviço.');
    console.warn(`  Esperado:   ${JSON.stringify(fases.documentosEsperados)}`);
    console.warn(`  Encontrado: ${JSON.stringify(documentosEncontrados)}`);
    return { ok: false, motivo: 'documentos não conferem', ...extracao };
  }

  console.log('[etapa-3] Documentos conferem. Prosseguindo para etapa 4...');

  // Etapa 4 — Dados Básicos → ESAJ
  const esajAba = await abrirProcessoNoESAJ(page, context);
  extracao.processoUrl = esajAba.url();
  salvarExtracao(extracao);

  // Etapa 5 — Localizar pasta do serviço no servidor (independente do ESAJ)
  const { pastaServico, pastaRecente } = localizarPastaServico(extracao.servico);
  extracao.pasta = { servico: pastaServico, recente: pastaRecente };
  salvarExtracao(extracao);

  // Etapa 6 — Extrair cabeçalho da 1ª página do PDF (documentosEsperados[0] = não é alvará)
  const cabecalhoDoc = await extrairCabecalhoDocumento(pastaRecente, fases.documentosEsperados[0]);
  extracao.cabecalhoDoc = cabecalhoDoc;
  salvarExtracao(extracao);

  // TODO: Etapas 7-10 — comparação ESAJ × documento e protocolo

  // Fecha a aba ESAJ e retorna foco ao SIGAD
  await esajAba.close();
  await page.bringToFront();

  // TODO: Etapa 11 — Encaminhar (aguardando Etapas 6-10)
  // await encaminharServico(page, {
  //   nome: ENCAMINHAR_NOME,
  //   observacao: fases.observacao,
  // });
  // extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'AGUARDAR PROTOCOLO', observacao: fases.observacao };
  // salvarExtracao(extracao);

  return { ok: true, ...extracao, esajAba };
}

// ── Fluxo principal ───────────────────────────────────────────────────────────

async function main() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(SIGAD_INICIO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await aguardarAjax(page);
    console.log(`[auto-protocolar] Página inicial: ${page.url()}`);

    // TODO: iterar sobre todos os serviços em formServico:tabela_data
    const resultado = await processarServico(page, context);
    console.log('\n[auto-protocolar] Resultado:', JSON.stringify(resultado, null, 2));

  } catch (err) {
    console.error('[auto-protocolar] Erro:', err.message);
    console.error(err.stack);
  } finally {
    console.log('\n[auto-protocolar] Concluído. Feche o browser quando terminar.');
    await new Promise(() => {});
  }
}

main().catch(err => {
  console.error('[auto-protocolar] Erro fatal:', err.message);
  process.exit(1);
});

module.exports = { processarServico, extrairFases, extrairDocumentos, abrirProcessoNoESAJ, encaminharServico };
