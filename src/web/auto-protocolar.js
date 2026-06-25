// auto-protocolar.js — Etapas 2-4: Fases → Documentos → Dados Básicos → ESAJ

'use strict';

const { abrirBrowser } = require('./crawler');

const SIGAD_INICIO_URL = 'https://sistemas.vcpericia.com.br/sigad/inicio/index.xhtml';

// ── Seletores confirmados via recorder (fluxo-protocolar) ────────────────────

const SEL = {
  // Etapa 1 — tabela de serviços e item clicável
  SERVICO_LINHAS: '[id="formServico:tabela_data"] tr',
  SERVICO_ITEM:   'span.Fs14.FontSemiBold',

  // Tabs (dentro do tabViewEvento do dialog de serviço)
  TAB_FASES: '[id="formDlgVerServico:tabViewEvento"] a:has-text("Fases")',
  TAB_DOCS:  '[id="formDlgVerServico:tabViewEvento"] a:has-text("Documentos")',
  TAB_DADOS: '[id="formDlgVerServico:tabViewEvento"] a:has-text("Dados Básicos")',

  // Linhas das tabelas PrimeFaces (corpo dos dados)
  FASES_LINHAS: '[id="formDlgVerServico:tabViewEvento:tabListaFase_data"] tr',
  DOCS_LINHAS:  '[id="formDlgVerServico:tabViewEvento:tabListaDocumento_data"] tr',
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

// ── Fluxo por serviço ─────────────────────────────────────────────────────────

async function processarServico(page, context) {
  // Etapa 1 — Abre o dialog do serviço (exibe as abas Fases, Documentos, Dados Básicos)
  await page.locator(SEL.SERVICO_LINHAS).first().locator(SEL.SERVICO_ITEM).click();
  await aguardarAjax(page);
  await page.locator('[id="formDlgVerServico"]').waitFor({ state: 'visible', timeout: 10000 });

  // Etapa 2 — Fases
  const fases = await extrairFases(page);
  if (!fases) return { ok: false, motivo: 'sem fases' };

  // Etapa 3 — Documentos
  const documentosEncontrados = await extrairDocumentos(page, fases.temAlvara);
  const confere = conferirDocumentos(fases.documentosEsperados, documentosEncontrados);

  if (!confere) {
    console.warn('[etapa-3] Documentos não conferem com a Fase — encerrando serviço.');
    console.warn(`  Esperado:   ${JSON.stringify(fases.documentosEsperados)}`);
    console.warn(`  Encontrado: ${JSON.stringify(documentosEncontrados)}`);
    return { ok: false, motivo: 'documentos não conferem', fases, documentosEncontrados };
  }

  console.log('[etapa-3] Documentos conferem. Prosseguindo para etapa 4...');

  // Etapa 4 — Dados Básicos → ESAJ
  const esajAba = await abrirProcessoNoESAJ(page, context);

  return { ok: true, fases, documentosEncontrados, esajAba };
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

module.exports = { processarServico, extrairFases, extrairDocumentos, abrirProcessoNoESAJ };
