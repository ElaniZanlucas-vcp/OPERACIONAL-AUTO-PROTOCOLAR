// auto-protocolar.js — Etapas 2-4 e 11: Fases → Documentos → Dados Básicos → ESAJ → Encaminhar

'use strict';

const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
// const nodemailer       = require('nodemailer');
const { abrirBrowser } = require('./crawler');
const { fazerLogin }   = require('./auth');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const SIGAD_LOGIN_URL  = 'https://sistemas.vcpericia.com.br/sigad/';
const ESAJ_LOGIN_URL   = 'https://esaj.tjms.jus.br/sajcas/login/aba-certificado';
const EXTRACAO_FILE    = path.resolve(__dirname, '../../data/extracao-protocolo.json');
const PENDING_FILE     = path.resolve(__dirname, '../../data/pending.json');
const ENCAMINHAR_FILE  = path.resolve(__dirname, '../../data/encaminhar.json');
const TRABALHOS_FINAIS = process.env.TRABALHOS_FINAIS;

const ENCAMINHAR_NOME     = 'Dayane Franco Alves';
const SERVICOS_EXCLUIDOS  = ['26872']; // normalizado sem pontos

// ── Seletores confirmados via recorder ───────────────────────────────────────

const SEL = {
  // Etapa 1 — tabela de serviços e item clicável
  SERVICO_LINHAS: '[id="formServico:tabela_data"] tr',
  SERVICO_ITEM:   'span.Fs14.FontSemiBold',

  // Tabs do dialog formDlgVerServico (confirmadas: fluxo-protocolar + encaminhar)
  TAB_FASES:  '[id="formDlgVerServico:tabViewEvento"] a:has-text("Fases")',
  TAB_DOCS:   '[id="formDlgVerServico:tabViewEvento"] a:not(.ui-commandlink):has-text("Documentos")',
  TAB_LAUDOS: '[id="formDlgVerServico:tabViewEvento"] a:not(.ui-commandlink):has-text("Laudos")',
  TAB_DADOS:  '[id="formDlgVerServico:tabViewEvento"] a:has-text("Dados Básicos")',

  // Linhas das tabelas de fases e documentos (vista)
  FASES_LINHAS: '[id="formDlgVerServico:tabViewEvento:tabListaFase_data"] tr',
  DOCS_LINHAS:  '[id="formDlgVerServico:tabViewEvento:tabListaDocumento_data"] tr',

  // Etapa 11 — Encaminhar
  // IDs dinâmicos (j_idt*) são resolvidos com fallback em cascata dentro de encaminharServico()
  BTN_EDITAR:    '[id="formDlgVerServico"] span.ui-button-text:has-text("Editar")',
  DLG_ENCAMINHAR: '[id="formDlgEnviarServico"]',
  NOME_INPUT:     '[id="formDlgEnviarServico:inputUsuario_input"]',
  NOME_PANEL:     '[id="formDlgEnviarServico:inputUsuario_panel"]',
  SUBFASE_LABEL:  '[id="formDlgEnviarServico:inputSubfase_label"]',
  SUBFASE_PANEL:  '[id="formDlgEnviarServico:inputSubfase_panel"]',
  OBS_FASE:       '[id="formDlgEnviarServico:inputObsFase"]',
  BTN_FECHAR_DLG:      '.ui-dialog:has([id="formDlgVerServico"]) a.ui-dialog-titlebar-close',
};



// ── Helpers Node.js ───────────────────────────────────────────────────────────

async function fecharDialogServico(page) {
  const btn = page.locator(SEL.BTN_FECHAR_DLG);
  const visivel = await btn.isVisible().catch(() => false);
  if (visivel) {
    await btn.click();
    await aguardarAjax(page);
  }
}

async function aguardarAjax(page) {
  await page.waitForFunction(
    () => typeof window.PrimeFaces === 'undefined' || window.PrimeFaces.ajax.Queue.isEmpty(),
    { timeout: 15000 }
  ).catch(() => {});
}

// ── Login ESAJ (certificado digital) ─────────────────────────────────────────

function esajSessaoExpirada(page) {
  const url = page.url();
  return url.includes('esaj.tjms.jus.br') &&
    (url.includes('sajcas') || url.includes('/login') || url.includes('sessionExpired'));
}

async function loginEsaj(context, pageExistente = null) {
  const page        = pageExistente ?? await context.newPage();
  const fecharAoFim = !pageExistente;
  try {
    await page.goto(ESAJ_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!esajSessaoExpirada(page)) { console.log('[esaj] Já autenticado.'); return true; }
    await page.locator('#linkAbaCertificado').click();
    console.log('[esaj] Aguardando seleção de certificado (5s)...');
    await new Promise(r => setTimeout(r, 5000));
    await page.locator('#submitCertificado').click();
    await page.waitForFunction(
      () => !window.location.href.includes('sajcas') && !window.location.href.includes('/login'),
      { timeout: 10000 }
    ).catch(() => console.warn('[esaj] Timeout aguardando pós-login.'));
    const logado = !esajSessaoExpirada(page);
    console.log(logado ? '[esaj] Login confirmado.' : '[esaj] Login não confirmado.');
    return logado;
  } finally {
    if (fecharAoFim) await page.close();
  }
}

// "doc1 // doc2" → ['doc1', 'doc2']  (doc2 é sempre Alvará quando presente)
// Fallback de separadores: // → ; → " - " (entre dois códigos de documento)
// " - " como sufixo de descrição continua sendo removido no caso de doc único.
function parsearDocsObservacao(observacao) {
  const obs = observacao.trim();

  // Extrai só o código de um token que pode vir como "CÓDIGO - descrição", "CÓDIGO. descrição" ou "CÓDIGO descrição".
  // Só corta a descrição quando o primeiro fragmento parece código (letras seguidas de dígito).
  // Códigos puramente numéricos (ex: 38380) são devolvidos inteiros.
  function extrairCodigo(token) {
    const semDash = token.trim().replace(/\s+-\s+.*$/, '').trim();
    const primeiro = semDash.split(/[\s.]+/)[0];
    return /^[A-Za-z]+\d/.test(primeiro) ? primeiro : semDash;
  }

  if (obs.includes('//'))
    return obs.split('//').map(extrairCodigo).filter(Boolean);

  if (obs.includes(';'))
    return obs.split(';').map(extrairCodigo).filter(Boolean);

  // " - " só vira separador quando ambos os lados parecem código (letras+dígito, sem espaço interno)
  const partesDash = obs.split(/\s+-\s+/);
  if (partesDash.length > 1 && partesDash.every(p => /^[A-Za-z]+\d/.test(p.trim()) && !p.trim().includes(' ')))
    return partesDash.map(d => d.trim()).filter(Boolean);

  return obs ? [extrairCodigo(obs)] : [];
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
      .map(row => ({
        documento:     valorCelula(celulaPorTitulo(row, 'Documento')),
        tipoDocumento: valorCelula(celulaPorTitulo(row, 'Tipo Documento')),
        responsavel:   valorCelula(celulaPorTitulo(row, 'Responsável')),
      }));
  }, { seletorLinhas: SEL.DOCS_LINHAS, qtd });

  // Quando há Alvará, garante que ele fica sempre em índice 1 (doc2),
  // independente da ordem exibida pelo SIGAD.
  if (temAlvara && documentos.length === 2) {
    const idxAlvara = documentos.findIndex(d =>
      d.tipoDocumento.toUpperCase().includes('ALVARA')
    );
    if (idxAlvara === 0) documentos.reverse();
  }
  // Responsável é relevante apenas para o documento principal (índice 0)
  documentos.slice(1).forEach(d => { d.responsavel = null; });

  console.log(`[etapa-3] Docs encontrados (${documentos.length}): ${JSON.stringify(documentos)}`);
  return documentos;
}

// ── Etapa 3.1: Acessar Laudos (quando a Fase é Laudo) ────────────────────────
//
// Quando a Fase é Laudo, o documento principal não é peticionado a partir da aba
// Documentos, e sim da aba Laudos — validado via teste-laudo.js. Diferente de
// Documentos/Fases (p:dataTable com thead/tbody), a aba Laudos é um p:dataGrid
// (um cartão por laudo, sem colunas), então a extração não usa celulaPorTitulo.
//
// O texto do documento não fica dentro de a.ui-commandlink (esse link não carrega
// texto próprio — inspecionado via recorder.js, o elemento clicado pelo usuário
// foi um <span> sem id, separado do link de ação/download). Por isso o documento
// é identificado pelo padrão do próprio código (ex: "L28639_8398": letras +
// dígitos + "_" + dígitos), varrendo as linhas de texto do cartão.

async function extrairAbaLaudos(page) {
  const aba = page.locator(SEL.TAB_LAUDOS);
  if ((await aba.count()) === 0) {
    console.warn('[etapa-3.1] Aba "Laudos" não encontrada no dialog deste serviço.');
    return [];
  }

  console.log('[etapa-3.1] Clicando na aba Laudos...');
  await aba.click();
  await aguardarAjax(page);
  // aguardarAjax só garante fila do PrimeFaces vazia, não que o DOM já refletiu a resposta
  await page.waitForTimeout(1500);

  const laudos = await page.evaluate(() => {
    const tabView = document.querySelector('[id="formDlgVerServico:tabViewEvento"]');
    if (!tabView) return [];

    // Busca direta pelo id fixo do p:dataGrid ("servico") em qualquer profundidade —
    // evita depender de identificar qual painel do TabView está "ativo".
    const gridContent = tabView.querySelector('[id$=":servico_content"]');
    if (!gridContent) return [];

    return [...gridContent.children].map(cartao => {
      const linhas = cartao.innerText.split('\n').map(l => l.trim()).filter(Boolean);

      const documento = linhas.find(l => /^[A-Za-z]+\d+_\d+$/.test(l)) ?? '';

      const idxConclusao = linhas.findIndex(l => l.startsWith('Data da conclusão'));
      const responsavelBruto = idxConclusao >= 0 ? (linhas[idxConclusao + 1] || '') : '';

      return {
        documento,
        tipoDocumento: 'LAUDO',
        responsavel: responsavelBruto.replace(/\s*\([^)]*\)\s*$/, '').trim() || null,
      };
    }).filter(l => l.documento);
  });

  console.log(`[etapa-3.1] Laudos encontrados (${laudos.length}): ${JSON.stringify(laudos)}`);
  return laudos;
}

// doc1 // doc2 da Fase = doc1, doc2 por ordem de mais recente nos Documentos
function conferirDocumentos(esperados, encontrados) {
  if (esperados.length !== encontrados.length) return false;
  return esperados.every((esp, i) =>
    encontrados[i]?.documento?.toLowerCase().includes(esp.toLowerCase())
  );
}

// ── Etapa 4: Dados Básicos → abrir processo no ESAJ ──────────────────────────

async function abrirProcessoNoESAJ(page, context) {
  console.log('[etapa-4] Clicando na aba Dados Básicos...');
  await page.locator(SEL.TAB_DADOS).click();
  await aguardarAjax(page);

  const linkProcesso = page
    .locator('[id="formDlgVerServico"] span')
    .filter({ hasText: /\d{7}-\d{2}\.\d{4}\.\d+\.\d+\.\d{4}/ })
    .first();

  const numeroProcesso = (await linkProcesso.textContent()).trim();
  console.log(`[etapa-4] Processo: ${numeroProcesso}`);
  console.log('[etapa-4] Clicando no processo...');
  const [esajAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    linkProcesso.click(),
  ]);

  await esajAba.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  console.log(`[etapa-4] ESAJ aberto: ${esajAba.url()}`);

  // Re-autentica ESAJ se a sessão expirou
  if (esajSessaoExpirada(esajAba)) {
    console.warn('[etapa-4] Sessão ESAJ expirada — re-autenticando...');
    await loginEsaj(context);
    await esajAba.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  // Aguarda carregamento completo do processo (#linkPasta só aparece após o search.do processar)
  const linkPasta = esajAba.locator('#linkPasta');
  let linkPastaVisivel = await linkPasta.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  for (let t = 1; t <= 3 && !linkPastaVisivel; t++) {
    console.warn(`[etapa-4] #linkPasta não visível (tentativa ${t}/3 — reCAPTCHA?). Aguardando 2s...`);
    await esajAba.waitForTimeout(2000);
    linkPastaVisivel = await linkPasta.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  }

  if (!linkPastaVisivel) {
    throw new Error('[etapa-4] ESAJ não carregou o processo após 3 tentativas (reCAPTCHA ou processo não encontrado).');
  }

  console.log(`[etapa-4] Processo carregado: ${esajAba.url()}`);
  return { esajAba, numeroProcesso };
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

// ── Etapa 5b: Extrair cabeçalho da 1ª página do PDF ─────────────────────────

// Rótulos de autor/réu por tipo de processo — abreviados e por extenso, inclusive feminino.
// Masculino/feminino nos rótulos de réu unificados com [OA] (ex: EXECUTAD[OA]).
const SIGLAS_AUTOR = [
  'REQTE',          // requerente
  'EXEQTE',         // exequente (abrev)
  'EXEQUENTE',      // exequente (extenso)
  'LIQUIDANTE',     // liquidação
  'LIQTE',          // liquidante (abrev)
  'INVENTARIANTE',  // inventário
  'IMPUGNANTE',     // impugnação
  'IMPUGTE',        // impugnante (abrev)
  'RECONVINTE',     // reconvenção
  'RECONVTE',       // reconvinte (abrev)
  'EMBARGANTE',     // embargos
  'EMBARGTE',       // embargante (abrev)
].join('|');

const SIGLAS_REU = [
  'REQD[OA]',            // requerido
  'EXECTD[OA]',       // executado/executada (abrev)
  'EXECUTAD[OA]',     // executado/executada (extenso)
  'LIQUIDAD[OA]',     // liquidado/liquidada
  'LIQD[OA]',         // liquidado/liquidada (abrev)
  'INVENTARIAD[OA]',  // inventariado/inventariada
  'INVTD[OA]',        // inventariado/inventariada (abrev)
  'IMPUGNAD[OA]',     // impugnado/impugnada
  'IMPUGD[OA]',       // impugnado/impugnada (abrev)
  'RECONVIND[OA]',    // reconvindo/reconvinda
  'RECONVD[OA]',      // reconvindo/reconvinda (abrev)
  'EMBARGAD[OA]',     // embargado/embargada (extenso)
  'EMBARGD[OA]',      // embargado/embargada (abrev)
].join('|');

// reqdo é o último campo da ORDEM — sem campo seguinte que o feche via INICIO_CAMPO.
// Quando o documento não tem linha em branco entre o nome da parte e o parágrafo de
// qualificação do perito/empresa peticionante (boilerplate fixo de toda petição da
// VCP), o campo "vaza" e absorve o restante da página. Dois freios independentes:
// 1) marcador textual que sempre abre esse parágrafo; 2) teto de linhas por nome de
// parte (autor/réu raramente passam de 1-2 linhas no cabeçalho do documento).
const FIM_QUALIFICACAO_PERITO_RE = /^VINICIUS\s+COUTINHO\b/i;
const MAX_LINHAS_NOME_PARTE = 3;

// Extrai os campos do cabeçalho do PDF em passo único e na ordem esperada do documento.
// Cada campo só é procurado após o campo anterior ter sido encontrado (ou descartado),
// impedindo que "AÇÃO" seja capturada de "CERTIFICAÇÃO" no corpo ou de menções tardias.
// Campos multilinhas são unidos; linhas em branco fecham o campo, exceto para aoJuizo
// (que pode ter quebras de linha entre vara e foro e só fecha em outro campo conhecido).
function extrairCamposSequenciais(linhas) {
  const ORDEM = [
    { key: 'aoJuizo',  re: /^AO\s+JU[ÍI]ZO[\s:]+(.+)/i, continueOnBlank: true },
    { key: 'processo', re: /^AUTOS[:\s]+(.*)/i },
    { key: 'classe',   re: /^A[ÇC][ÃA]O[:\s]+(.*)/i },
    { key: 'reqte',    re: new RegExp(`^(?:${SIGLAS_AUTOR})[:\\s]+(.*)`, 'i') },
    { key: 'reqdo',    re: new RegExp(`^(?:${SIGLAS_REU})[:\\s]+(.*)`, 'i') },
  ];
  const INICIO_CAMPO = new RegExp(
    `^(AO\\s+JU[ÍI]ZO|AUTOS|A[ÇC][ÃA]O|${SIGLAS_AUTOR}|${SIGLAS_REU})\\b`, 'i'
  );

  const resultado = {};
  let capturandoKey = null;
  let continueOnBlank = false;
  let partes = [];
  let proximoIdx = 0;

  function fecharCampo() {
    if (capturandoKey && partes.length) {
      resultado[capturandoKey] = partes.join(' ').replace(/\s+/g, ' ').trim();
    }
    capturandoKey = null;
    continueOnBlank = false;
    partes = [];
  }

  for (const linha of linhas) {
    const trimmed = linha.trim();
    const ehNomeParte = capturandoKey === 'reqte' || capturandoKey === 'reqdo';

    if (capturandoKey) {
      if (ehNomeParte && FIM_QUALIFICACAO_PERITO_RE.test(trimmed)) {
        // Início do parágrafo de qualificação do perito — nunca é parte do nome.
        fecharCampo();
        continue;
      } else if (INICIO_CAMPO.test(trimmed)) {
        fecharCampo();
        // cai para verificar se esta linha inicia novo campo
      } else if (!trimmed) {
        if (!continueOnBlank) fecharCampo();
        continue; // linha em branco: fecha (ou ignora) e não tenta abrir novo campo
      } else if (ehNomeParte && partes.length >= MAX_LINHAS_NOME_PARTE) {
        // Nome de parte improvavelmente continua por tantas linhas sem separador —
        // provável vazamento para o corpo do documento. Encerra sem incluir mais.
        fecharCampo();
        continue;
      } else {
        partes.push(trimmed);
        continue;
      }
    }

    if (!trimmed || proximoIdx >= ORDEM.length) continue;

    for (let i = proximoIdx; i < ORDEM.length; i++) {
      const m = trimmed.match(ORDEM[i].re);
      if (m) {
        proximoIdx = i + 1;
        capturandoKey = ORDEM[i].key;
        continueOnBlank = ORDEM[i].continueOnBlank ?? false;
        const primeiro = m[1].trim();
        partes = primeiro ? [primeiro] : [];
        break;
      }
    }
  }

  fecharCampo();
  return resultado;
}

async function extrairCabecalhoDocumento(pastaRecente, nomeDocumento) {
  const nomeLower = nomeDocumento.toLowerCase();
  const arquivo = fs.readdirSync(pastaRecente).find(f =>
    f.toLowerCase().endsWith('.pdf') && f.toLowerCase().includes(nomeLower)
  );

  if (!arquivo) {
    throw new Error(`[etapa-5] PDF não encontrado para "${nomeDocumento}" em ${pastaRecente}`);
  }

  const caminho = path.join(pastaRecente, arquivo);
  console.log(`[etapa-5] Lendo PDF: ${caminho}`);

  const buffer = fs.readFileSync(caminho);
  const { text } = await pdfParse(buffer, { max: 1 }); // 1ª página

  // NFC: recompõe caracteres decompostos (ex: I+combining acute → Í) para que os regexes casem
  const linhas = text.normalize('NFC').split('\n');
  const campos = extrairCamposSequenciais(linhas);

  // Fallback: partes embutidas na mesma linha da AÇÃO
  // Ex: "LIQUIDAÇÃO POR ARBITRAMENTO EXEQTE: RAMÃO ALVES EXECTDO: PAX NACIONAL..."
  if (!campos.reqte && campos.classe) {
    const re = new RegExp(
      `^(.*?)\\s+\\b(${SIGLAS_AUTOR})\\b[\\s:]+(.+?)\\s+\\b(${SIGLAS_REU})\\b[\\s:]+(.+)$`, 'i'
    );
    const m = campos.classe.match(re);
    if (m) {
      campos.classe = m[1].trim();
      campos.reqte  = m[3].trim();
      campos.reqdo  = m[5].trim();
    }
  }

  const varaForo = campos.aoJuizo?.match(/DA (.+?) DA COMARCA DE (.+)/i);

  const cabecalho = {
    vara:     varaForo?.[1]?.trim() ?? null,
    foro:     varaForo?.[2]?.trim() ?? null,
    processo: campos.processo       ?? null,
    classe:   campos.classe         ?? null,
    reqte:    campos.reqte          ?? null,
    reqdo:    campos.reqdo          ?? null,
    arquivo,
  };

  console.log('[etapa-5] Cabeçalho do documento:', JSON.stringify(cabecalho, null, 2));
  return cabecalho;
}

// ── Etapa 6: Partes e cabeçalho do ESAJ ──────────────────────────────────────

function classificarRoleESAJ(labelRaw) {
  const l = labelRaw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.:*]/g, '')
    .trim()
    .toUpperCase();

  const AUTOR = [
    /^AUTOR[A]?$/,
    /^EXEQ/,
    /^REQ(T|NT|UER)/,
    /^RECLAM(T|ANT)/,
    /^EMBARG(T|ANT|ANTE|UE)/,
    /^IMPET(T|RANT)/,
    /^LIQ(T|ANT|UIDAN)/,
    /^INV(ANT|ARIAN)/,
    /^IMPUGN(T|ANT|ANTE)/,
    /^RECONVINT/,
  ];

  const REU = [
    /^(REU|RE)$/,
    /^EXEC(T|UT)/,
    /^REQ(D|ERID)/,
    /^RECLAM(D|AD)/,
    /^EMBARG(D|AD)/,
    /^IMPETR(D|AD)/,
    /^LIQ(D|UID)/,
    /^INV(AD|ENTARIAD)/,
    /^IMPUGN(D|AD)/,
    /^RECONVIND/,
  ];

  for (const re of AUTOR) { if (re.test(l)) return 'AUTOR'; }
  for (const re of REU)   { if (re.test(l)) return 'RÉU'; }
  return null;
}

async function extrairPartesDoESAJ(esajPage) {
  const dadosBrutos = await esajPage.evaluate(() => {
    function extrairLinhasDaTabela(tabela) {
      const linhas = [];
      for (const tr of tabela.querySelectorAll('tr')) {
        if (tr.id === 'trPartesMais') continue;
        const tds = [...tr.querySelectorAll('td')];
        if (tds.length < 2) continue;
        const label = tds[0].textContent.trim().replace(/:$/, '').trim();
        if (!label) continue;
        const primeiraLinha = tds[1].innerHTML
          .split(/<br\s*\/?>/i)[0]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        linhas.push({ label, nome: primeiraLinha });
      }
      return linhas;
    }

    const tabelaPrincipal = document.getElementById('tablePartesPrincipais');
    const tabelaCompleta  = document.getElementById('tableTodasPartes');
    return {
      linhasPrincipais: tabelaPrincipal ? extrairLinhasDaTabela(tabelaPrincipal) : null,
      linhasCompletas:  tabelaCompleta  ? extrairLinhasDaTabela(tabelaCompleta)  : null,
    };
  });

  const { linhasPrincipais, linhasCompletas } = dadosBrutos;
  console.log(`[etapa-6][partes] tableTodasPartes ${linhasCompletas ? 'presente' : 'ausente'}.`);

  if (!linhasPrincipais) {
    console.warn('[etapa-6][partes] #tablePartesPrincipais não encontrada.');
    return [];
  }

  const todasPartes = linhasCompletas ? { AUTOR: [], 'RÉU': [] } : null;
  if (linhasCompletas) {
    for (const { label, nome } of linhasCompletas) {
      const labelNorm = label.replace(/[.:]$/, '').trim();
      if (/^Advogad[ao]s?$/i.test(labelNorm)) continue;
      const role = classificarRoleESAJ(labelNorm);
      if (!role) continue;
      const nomeMaiusc = nome.toUpperCase().trim();
      if (!nomeMaiusc || /^SEM\s/i.test(nomeMaiusc)) continue;
      todasPartes[role].push(nomeMaiusc);
    }
  }

  const porRole = new Map();
  for (const { label, nome } of linhasPrincipais) {
    const labelNorm = label.replace(/[.:]$/, '').trim();
    if (/^Advogad[ao]s?$/i.test(labelNorm)) continue;
    const role = classificarRoleESAJ(labelNorm);
    if (!role) continue;
    if (porRole.has(role)) continue;
    const nomeMaiusc = nome.toUpperCase().trim();
    if (!nomeMaiusc || /^SEM\s/i.test(nomeMaiusc)) continue;
    porRole.set(role, nomeMaiusc);
  }

  const partes = [];
  for (const [participacao, nome] of porRole) {
    const total = todasPartes ? todasPartes[participacao].length : 0;
    const sufixo = total > 1 ? ' E OUTROS' : '';
    partes.push({ participacao, nome: nome + sufixo });
  }

  return { partes, todasPartes };
}

async function extrairCabecalhoDoESAJ(esajPage, numeroProcesso) {
  const dados = await esajPage.evaluate(() => {
    function porLabel(textoLabel) {
      for (const th of document.querySelectorAll('th, td.nomezinho, .label')) {
        const texto = th.textContent.trim().replace(/:$/, '').trim();
        if (texto.toLowerCase() === textoLabel.toLowerCase()) {
          const next = th.nextElementSibling;
          return next ? next.textContent.trim().replace(/\s+/g, ' ') : '';
        }
      }
      return '';
    }

    const classeEl = document.getElementById('classeProcesso');
    const foroEl   = document.getElementById('foroProcesso');
    const varaEl   = document.getElementById('varaProcesso');

    return {
      classe: (classeEl?.textContent.trim() || porLabel('Classe')).replace(/\s+/g, ' '),
      foro:   (foroEl?.textContent.trim()   || porLabel('Foro')).replace(/\s+/g, ' '),
      vara:   (varaEl?.textContent.trim()   || porLabel('Vara')).replace(/\s+/g, ' '),
    };
  });

  return {
    numeroProcesso: numeroProcesso.toUpperCase(),
    classe:         dados.classe.toUpperCase(),
    foro:           dados.foro.toUpperCase(),
    vara:           dados.vara.toUpperCase(),
  };
}

// ── Etapa 7: Conferir dados do documento × ESAJ ──────────────────────────────

function normalizar(str) {
  if (!str) return '';
  return str
    .replace(/^'+/, '')                   // remove apóstrofo inicial (artefato ESAJ)
    .replace(/&amp;/gi, '&')              // decodifica entidade HTML (&AMP; do ESAJ)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toUpperCase()
    .replace(/\bIMISSAO (DE|NA) POSSE\b/g, 'IMISSAO POSSE') // "Imissão de Posse" == "Imissão na Posse" (classe)
    .replace(/\/[A-Z]{2,3}\.?\s*$/, '')  // remove /MS. /MT. /SP. no final (foro)
    .replace(/\bS\/A\b/g, 'SA')          // S/A → SA antes de converter barras
    .replace(/\//g, ' ')                  // barras restantes → espaço
    .replace(/\s+-\s+/g, ' ')            // "Comaves - Industria" → "Comaves Industria"
    .replace(/[.,]/g, '')                 // remove pontuação (S.A. → SA)
    .replace(/\b0+(\d+[ªº°])/g, '$1')    // 02ª → 2ª (apenas ordinais, não afeta n° processo)
    .replace(/\s+/g, ' ')
    .replace(/\bS A\b/g, 'SA')           // S. A. → após remoção de pontos e colapso vira "S A"
    .trim();
}

function camposBatem(docVal, esajVal) {
  const d = normalizar(docVal);
  const e = normalizar(esajVal);
  if (!d && !e) return true;
  return d === e;
}

function nomesBatem(docVal, esajVal) {
  const d = normalizar(docVal);
  const e = normalizar(esajVal);
  if (!d && !e) return true;
  if (d === e) return true;
  // Leniência para "E OUTROS": compara apenas o primeiro nome
  const baseD = d.replace(/\s+E OUTROS$/, '').trim();
  const baseE = e.replace(/\s+E OUTROS$/, '').trim();
  return baseD === baseE;
}

function conferirEtapa7(cabecalhoDoc, esaj) {
  const { partes, cabecalho: esajCab } = esaj;

  const autorESAJ = partes.find(p => p.participacao === 'AUTOR')?.nome ?? '';
  const reuESAJ   = partes.find(p => p.participacao === 'RÉU')?.nome   ?? '';

  const campos = [
    { campo: 'vara',     doc: cabecalhoDoc.vara,     esaj: esajCab.vara,           fn: camposBatem },
    { campo: 'foro',     doc: cabecalhoDoc.foro,     esaj: esajCab.foro,           fn: camposBatem },
    { campo: 'processo', doc: cabecalhoDoc.processo, esaj: esajCab.numeroProcesso, fn: camposBatem },
    { campo: 'classe',   doc: cabecalhoDoc.classe,   esaj: esajCab.classe,         fn: camposBatem },
    { campo: 'autor',    doc: cabecalhoDoc.reqte,    esaj: autorESAJ,              fn: nomesBatem  },
    { campo: 'reu',      doc: cabecalhoDoc.reqdo,    esaj: reuESAJ,                fn: nomesBatem  },
  ];

  const resultado = campos.map(({ campo, doc, esaj, fn }) => ({
    campo,
    doc:  doc  ?? '',
    esaj: esaj ?? '',
    bate: fn(doc, esaj),
  }));

  const ok = resultado.every(r => r.bate);

  console.log(`[etapa-7] Conferencia: ${ok ? '[OK]' : '[FALHA]'}`);
  for (const r of resultado) {
    console.log(`  [${r.bate ? 'OK' : 'XX'}] ${r.campo.padEnd(9)}: doc="${r.doc}" | esaj="${r.esaj}"`);
  }

  return { ok, campos: resultado };
}

// // ── Etapa 7.2 (negativo): Notificar divergência por e-mail ───────────────────

// function montarMensagemDivergencia(servico, conferencia) {
//   const divergentes = conferencia.campos.filter(c => !c.bate);
//   const linhas = divergentes.map(c =>
//     `• ${c.campo.toUpperCase()}: documento "${c.doc}" → processo "${c.esaj}"`
//   );
//   return [
//     `Olá, tudo bem?`,
//     ``,
//     `Identificamos uma divergência no documento do Serviço ${servico} que precisa de correção antes de protocolar:`,
//     ``,
//     ...linhas,
//     ``,
//     `Por favor, verifique e corrija o documento. Após a correção, reprocessaremos novamente.`,
//     ``,
//     `Atenciosamente, CLÁUDIO INÁCIO ANTÔNIO`,
//   ].join('\n');
// }

// async function notificarDivergencia(responsavel, conferencia, servico) {
//   if (!responsavel) {
//     console.warn('[etapa-7.2] Responsável não encontrado — notificação ignorada.');
//     return;
//   }

//   const remetente  = process.env.GMAIL_USUARIO;
//   const appPassword = process.env.GMAIL_APP_PASSWORD;

//   if (!remetente || !appPassword) {
//     console.warn('[etapa-7.2] GMAIL_USUARIO ou GMAIL_APP_PASSWORD ausentes no .env — notificação ignorada.');
//     return;
//   }

//   const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: { user: remetente, pass: appPassword },
//   });

//   const mensagem = montarMensagemDivergencia(servico, conferencia);

//   console.log(`[etapa-7.2] Enviando e-mail para "${responsavel}"...`);
//   await transporter.sendMail({
//     from:    remetente,
//     to:      responsavel,
//     subject: `[Auto-Protocolar] Divergência no Serviço ${servico}`,
//     text:    mensagem,
//   });

//   console.log('[etapa-7.2] E-mail enviado.');
// }

// ── Etapa 11: Encaminhar ──────────────────────────────────────────────────────

// IDs conhecidos por deploy — quando o fallback for usado, o console.warn mostra o ID real para atualizar aqui
const TAB_FASES_CONTAINER_IDS  = ['j_idt474', 'j_idt436', 'j_idt438'];
const BTN_ENCAMINHAR_IDS       = ['formServico:j_idt474:j_idt545', 'formServico:j_idt436:j_idt507', 'formServico:j_idt438:j_idt509'];
const BTN_SALVAR_FASE_IDS      = ['formDlgEnviarServico:j_idt714', 'formDlgEnviarServico:j_idt750', 'formDlgEnviarServico:j_idt712'];
const BTN_SALVAR_DETALHES_IDS  = ['formServico:j_idt471', 'formServico:j_idt433'];

async function encaminharServico(page, { nome, observacao, subfase = 'AGUARDAR PROTOCOLO' }) {
  console.log('[etapa-11] Clicando em Editar...');
  await page.locator(SEL.BTN_EDITAR).click();
  await aguardarAjax(page);

  // Aba Fases — testa IDs conhecidos; fallback por .ui-tabview-nav
  console.log('[etapa-11] Clicando na aba Fases...');
  let tabFases = null;
  for (const id of TAB_FASES_CONTAINER_IDS) {
    const loc = page.locator(`[id="formServico:${id}"] a:has-text("Fases")`);
    if (await loc.isVisible().catch(() => false)) { tabFases = loc; break; }
  }
  if (!tabFases) {
    const byNav = page.locator('[id="formServico"] .ui-tabview-nav a:has-text("Fases")');
    if ((await byNav.count().catch(() => 0)) > 0) {
      tabFases = byNav.first();
      const idContainer = await byNav.first()
        .evaluate(el => el.closest('.ui-tabview')?.id ?? '?').catch(() => '?');
      console.warn(`[etapa-11] TAB_FASES_EDIT: IDs conhecidos não encontrados. Fallback container="${idContainer}". Adicione em TAB_FASES_CONTAINER_IDS.`);
    }
  }
  if (!tabFases) throw new Error('[etapa-11] Aba Fases não encontrada após Editar.');
  await tabFases.click();
  await aguardarAjax(page);

  // Botão Encaminhar — testa IDs conhecidos; fallback por button no painel ativo
  console.log('[etapa-11] Clicando em Encaminhar...');
  let btnEncaminhar = null;
  for (const id of BTN_ENCAMINHAR_IDS) {
    const loc = page.locator(`[id="${id}"]`);
    if (await loc.isVisible().catch(() => false)) { btnEncaminhar = loc; break; }
  }
  if (!btnEncaminhar) {
    const byText = page
      .locator('[id="formServico"] .ui-tabview-panel:not(.ui-helper-hidden) button.ui-button:not(.ui-state-disabled)')
      .filter({ hasText: /encaminhar/i });
    if ((await byText.count().catch(() => 0)) > 0) {
      btnEncaminhar = byText.first();
      const idFallback = await btnEncaminhar.getAttribute('id').catch(() => '?');
      console.warn(`[etapa-11] BTN_ENCAMINHAR: usando fallback id="${idFallback}". Adicione em BTN_ENCAMINHAR_IDS.`);
    }
  }
  if (!btnEncaminhar) throw new Error('[etapa-11] Botão Encaminhar não encontrado.');
  await btnEncaminhar.click();
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

  // Subfase — SelectOneMenu
  console.log(`[etapa-11] Selecionando Subfase: ${subfase}...`);
  await page.locator(SEL.SUBFASE_LABEL).click();
  const subfasePanel = page.locator(SEL.SUBFASE_PANEL);
  await subfasePanel.waitFor({ state: 'visible', timeout: 5000 });
  await subfasePanel.locator(`li[data-label="${subfase}"]`).click();
  await aguardarAjax(page);

  // Observação
  console.log(`[etapa-11] Preenchendo Observação: "${observacao}"...`);
  const obsField = page.locator(SEL.OBS_FASE);
  await obsField.click({ clickCount: 3 });
  await obsField.fill(observacao);

  // Salvar Fase (botão "Encaminhar" dentro do dialog) — testa IDs conhecidos; fallback em cascata
  console.log('[etapa-11] Salvando Fase (Encaminhar no dialog)...');
  await page.locator(SEL.DLG_ENCAMINHAR).waitFor({ state: 'visible', timeout: 5000 });

  // Usa o container .ui-dialog (inclui footer) — PrimeFaces coloca botões fora do <form>
  const dlgContainer = page.locator('.ui-dialog:has([id="formDlgEnviarServico"])');

  // Diagnóstico: imprime todos os .ui-button do dialog para mapear o ID correto
  const botoesNoDialog = await dlgContainer.locator('.ui-button').evaluateAll(
    els => els.map(el => ({ id: el.id || '(sem id)', tag: el.tagName, texto: el.textContent?.trim().slice(0, 40) }))
  ).catch(() => []);
  console.log('[etapa-11] Botões no dialog Encaminhar:', JSON.stringify(botoesNoDialog));

  let btnSalvarFase = null;
  for (const id of BTN_SALVAR_FASE_IDS) {
    const loc = page.locator(`[id="${id}"]`);
    if (await loc.isVisible().catch(() => false)) { btnSalvarFase = loc; break; }
  }
  if (!btnSalvarFase) {
    // Fallback 1: qualquer .ui-button com texto de ação no container do dialog (exclui Cancelar/Fechar)
    const byText = dlgContainer
      .locator('.ui-button:not(.ui-state-disabled)')
      .filter({ hasText: /encaminhar|salvar/i })
      .filter({ hasNotText: /cancelar|fechar/i });
    if ((await byText.count().catch(() => 0)) > 0) {
      btnSalvarFase = byText.first();
      const idFallback = await btnSalvarFase.getAttribute('id').catch(() => '?');
      console.warn(`[etapa-11] BTN_SALVAR_FASE fallback-1 (texto): id="${idFallback}". Adicione em BTN_SALVAR_FASE_IDS.`);
    }
  }
  if (!btnSalvarFase) {
    // Fallback 2: último .ui-button habilitado do container, excluindo Cancelar/Fechar
    const actionBtns = dlgContainer
      .locator('.ui-button:not(.ui-state-disabled)')
      .filter({ hasNotText: /cancelar|fechar/i });
    const count = await actionBtns.count().catch(() => 0);
    if (count > 0) {
      btnSalvarFase = actionBtns.last();
      const idFallback = await btnSalvarFase.getAttribute('id').catch(() => '?');
      console.warn(`[etapa-11] BTN_SALVAR_FASE fallback-2 (last sem Cancelar): id="${idFallback}". Adicione em BTN_SALVAR_FASE_IDS.`);
    }
  }
  if (!btnSalvarFase) throw new Error('[etapa-11] Botão Salvar Fase não encontrado no dialog Encaminhar.');
  await btnSalvarFase.click();
  await aguardarAjax(page);
  console.log('[etapa-11] Fase salva.');

  // Salvar Detalhes do Serviço — testa IDs conhecidos; fallback por button "Salvar" no formServico
  console.log('[etapa-11] Salvando Detalhes do Serviço...');
  let btnSalvarDetalhes = null;
  for (const id of BTN_SALVAR_DETALHES_IDS) {
    const loc = page.locator(`[id="${id}"]`);
    if (await loc.isVisible().catch(() => false)) { btnSalvarDetalhes = loc; break; }
  }
  if (!btnSalvarDetalhes) {
    const byText = page
      .locator('[id="formServico"] button.ui-button:not(.ui-state-disabled)')
      .filter({ hasText: /salvar/i });
    if ((await byText.count().catch(() => 0)) > 0) {
      btnSalvarDetalhes = byText.first();
      const idFallback = await btnSalvarDetalhes.getAttribute('id').catch(() => '?');
      console.warn(`[etapa-11] BTN_SALVAR_DETALHES: usando fallback id="${idFallback}". Adicione em BTN_SALVAR_DETALHES_IDS.`);
    }
  }
  if (!btnSalvarDetalhes) throw new Error('[etapa-11] Botão Salvar Detalhes não encontrado.');
  await btnSalvarDetalhes.click();
  await aguardarAjax(page);
  console.log('[etapa-11] Detalhes do Serviço salvos.');
}

// ── Etapas 8-10: Protocolar no ESAJ ──────────────────────────────────────────

function resolverCodigoClassificacao(fase, subfase) {
  const f = fase.toUpperCase().trim();
  // SIGAD retorna a subfase com espaços ao redor do hífen (ex: "PROTOCOLAR - PRAZO") —
  // normaliza para "PROTOCOLAR-PRAZO" antes de comparar.
  const s = subfase.toUpperCase().trim().replace(/\s*-\s*/g, '-');
  if (s === 'PROTOCOLAR-PRAZO')  return 38423;
  if (s.startsWith('PROTOCOLAR-')) return 8822;
  if (s === 'PROTOCOLAR') {
    if (f === 'LAUDO' || f === 'ESCLARECIMENTO') return 38368;
    return 8822;
  }
  return null;
}

async function abrirFormularioPeticao(esajAba) {
  console.log('[etapa-7] Clicando em Peticionar...');
  await esajAba.locator('#dropdownCriarPeticaoInicial').click();
  await esajAba.locator('#linkPeticionar').waitFor({ state: 'visible', timeout: 5000 });
  await esajAba.locator('#linkPeticionar').click();
  // Aguarda o formulário carregar (botão de upload visível)
  await esajAba.locator('[aria-label="Adicionar arquivos elaborados"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  console.log('[etapa-7] Formulário de petição carregado.');
}

async function preencherDadosPeticao(esajAba, codigo) {
  console.log('[etapa-9] Preenchendo dados da petição...');

  // 1. PETICIONANTE — abrir dropdown → digitar → selecionar ÉRIKA → remover tag anterior
  console.log('[etapa-9] Peticionante...');
  const tagExistente = esajAba.locator('span.ui-select-match-text.pull-left').first();
  if (await tagExistente.isVisible()) {
    await tagExistente.click();
  } else {
    await esajAba.locator('span.ui-select-placeholder').first().click();
  }
  const searchPeticInput = esajAba.locator('input.ui-select-search').first();
  await searchPeticInput.waitFor({ state: 'visible', timeout: 5000 });
  await searchPeticInput.pressSequentially('ÉRIKA', { delay: 80 });
  const erikaRow = esajAba.locator('span.ui-select-choices-row-inner span')
    .filter({ hasText: /ÉRIKA PINTO NOGUEIRA.*Advogad/ });
  await erikaRow.waitFor({ state: 'visible', timeout: 8000 });
  await erikaRow.first().click();
  const cancelBtn = esajAba.locator('span.glyph.glyph-cancel');
  if (await cancelBtn.count() > 0) {
    await cancelBtn.first().click();
  }
  console.log('[etapa-9] Peticionante ÉRIKA selecionada.');

  // 2. CLASSIFICAÇÃO — rejeita sugestão (se houver) e digita o código sempre
  console.log('[etapa-9] Classificação...');
  const blocoClassificacao = esajAba.locator('#blocoClassificacao');
  await blocoClassificacao.waitFor({ state: 'visible', timeout: 15000 });

  const btnRejeitar = blocoClassificacao.locator('#containerClassificacaoSugestao #botaoRejeitarClassificacao');
  const temSugestao = await btnRejeitar.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (temSugestao) {
    console.log('[etapa-9] Sugestão detectada → rejeitando...');
    await btnRejeitar.click();
  }

  await esajAba.locator('span.va-m:has-text("Classificar")').waitFor({ state: 'visible', timeout: 10000 });
  await esajAba.locator('span.va-m:has-text("Classificar")').click();
  await esajAba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)')
    .waitFor({ state: 'visible', timeout: 5000 });
  await esajAba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)').click();
  await esajAba.locator('#selectClasseIntermediaria').pressSequentially(String(codigo), { delay: 80 });
  const opcaoCodigo = esajAba.locator('span.selecao-classe--nome').filter({ hasText: String(codigo) });
  await opcaoCodigo.waitFor({ state: 'visible', timeout: 8000 });
  await opcaoCodigo.first().click();
  await esajAba.locator('span.glyph.glyph-chevron-up').first().click();
  console.log(`[etapa-9] Classificação ${codigo} definida.`);

  // 3. SOLICITANTE: se já constar nas partes do processo → "Incluir parte" no card;
  //    caso contrário → formulário "Adicionar solicitante" com CNPJ
  console.log('[etapa-9] Solicitante...');
  const cardSolicitante = esajAba.locator('[id^="cardParte_"]').filter({ hasText: '01.088.089/0001-52' });
  const cardEncontrado  = await cardSolicitante.count() > 0;
  if (cardEncontrado) {
    await cardSolicitante.first().locator('.botao-incluir-polo').click();
    console.log('[etapa-9] Solicitante: encontrado na tabela → Incluir parte.');
  } else {
    await esajAba.locator('span.va-m:has-text("Adicionar solicitante")')
      .waitFor({ state: 'visible', timeout: 10000 });
    await esajAba.locator('span.va-m:has-text("Adicionar solicitante")').click();
    await esajAba.locator('label:has-text("Jurídica")').waitFor({ state: 'visible', timeout: 5000 });
    await esajAba.locator('label:has-text("Jurídica")').click();
    await esajAba.locator('#inputCnpj').waitFor({ state: 'visible', timeout: 5000 });
    await esajAba.locator('#inputCnpj').click();
    await esajAba.locator('#inputCnpj').pressSequentially('01088089000152', { delay: 80 });
    await esajAba.locator('body').click({ position: { x: 0, y: 0 } });
    await new Promise(r => setTimeout(r, 4000));
    await esajAba.locator('span.glyph.glyph-chevron-up').last().click();
    console.log('[etapa-9] Solicitante: não encontrado → adicionado por CNPJ.');
  }

  console.log('[etapa-9] Dados preenchidos.');
}


async function importarDocumentoESAJ(esajAba, filePath, { timeoutCarregamento = 3000 } = {}) {
  console.log(`[etapa-8] Enviando arquivo: ${path.basename(filePath)}`);
  // Dois botões com id "botaoAdicionarDocumento" — diferencia por aria-label
  const btnDoc = esajAba.locator('[aria-label="Adicionar arquivos elaborados"]');
  await btnDoc.waitFor({ state: 'visible', timeout: 10000 });
  const [fileChooser] = await Promise.all([
    esajAba.waitForEvent('filechooser'),
    btnDoc.click(),
  ]);
  await fileChooser.setFiles(filePath);
  console.log(`[etapa-8] Aguardando carregamento do arquivo (${timeoutCarregamento}ms)...`);
  await new Promise(r => setTimeout(r, timeoutCarregamento));
  console.log('[etapa-8] Arquivo carregado.');
}

async function tratarSugestaoClassificacao(aba, codigoEsperado) {
  // Aguarda o AJAX de análise do arquivo completar
  await new Promise(r => setTimeout(r, 2000));

  // Detecta sugestão pela presença do botão ✔ (glyph-ok) dentro de selecao-classe
  const btnAceitar  = aba.locator('selecao-classe span.glyph.glyph-ok');
  const btnRejeitar = aba.locator('selecao-classe span.glyph.glyph-remove');
  const temSugestao = await btnAceitar.count() > 0;

  if (!temSugestao) {
    console.log('[etapa-8] Sem sugestão de classificação após upload.');
    return;
  }

  // Lê o código sugerido pelo texto "NNNN - Descrição"
  const nomeSugestao   = await aba.locator('selecao-classe span.selecao-classe--nome').textContent().catch(() => '');
  const codigoSugerido = nomeSugestao.match(/^(\d+)/)?.[1];
  console.log(`[etapa-8] Sugestão detectada: "${nomeSugestao.trim()}" | Esperado: ${codigoEsperado}`);

  if (codigoSugerido === String(codigoEsperado)) {
    console.log('[etapa-8] Sugestão correta → aceitando (✔)...');
    await btnAceitar.first().click();
    await aba.locator('span.glyph.glyph-chevron-up').first().click();
  } else {
    console.log('[etapa-8] Sugestão incorreta → rejeitando (X) e re-selecionando...');
    await btnRejeitar.first().click();
    // Após rejeitar, "Classificar" volta a ficar visível
    await aba.locator('span.va-m:has-text("Classificar")').waitFor({ state: 'visible', timeout: 10000 });
    await aba.locator('span.va-m:has-text("Classificar")').click();
    await aba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)')
      .waitFor({ state: 'visible', timeout: 5000 });
    await aba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)').click();
    await aba.locator('#selectClasseIntermediaria')
      .pressSequentially(String(codigoEsperado), { delay: 80 });
    const opcao = aba.locator('span.selecao-classe--nome').filter({ hasText: String(codigoEsperado) });
    await opcao.waitFor({ state: 'visible', timeout: 8000 });
    await opcao.first().click();
    await aba.locator('span.glyph.glyph-chevron-up').first().click();
    console.log(`[etapa-8] Classificação ${codigoEsperado} re-selecionada.`);
  }
}

async function peticionarNoESAJ(esajAba, page, context, { pastaRecente, documentosEsperados, temAlvara, fase, subfase }) {
  const codigo = resolverCodigoClassificacao(fase, subfase);
  const docs   = temAlvara && documentosEsperados.length > 1
    ? [documentosEsperados[0], documentosEsperados[1]]
    : [documentosEsperados[0]];
  const codigos = [codigo, 38380];

  // Fase Laudo: timeout maior no import do documento principal (Laudo) para
  // conferirmos visualmente que o arquivo carrega corretamente no ESAJ.
  const faseELaudo = /LAUDO/i.test(fase);
  const TIMEOUT_IMPORT_PADRAO = 3000;
  const TIMEOUT_IMPORT_LAUDO  = 10000;

  console.log(`[peticionar] Fase: ${fase} | Subfase: ${subfase} | Código: ${codigo} | Total docs: ${docs.length}`);

  let abaAtual = esajAba;

  for (let i = 0; i < docs.length; i++) {
    const label = i === 0 ? 'Documento principal' : 'Alvará';

    if (i > 0) {
      // Volta ao SIGAD e reabre o processo no ESAJ pela mesma rota da Etapa 4
      console.log('[peticionar] Retornando ao SIGAD para abrir processo novamente (Alvará)...');
      await page.bringToFront();
      ({ esajAba: abaAtual } = await abrirProcessoNoESAJ(page, context));
    }

    console.log(`\n[peticionar] ${i + 1}/${docs.length} — ${label} (${docs[i]})`);
    const filePath = path.join(pastaRecente, docs[i] + '.pdf');

    await abrirFormularioPeticao(abaAtual);
    const timeoutCarregamento = (faseELaudo && i === 0) ? TIMEOUT_IMPORT_LAUDO : TIMEOUT_IMPORT_PADRAO;
    await importarDocumentoESAJ(abaAtual, filePath, { timeoutCarregamento });
    await preencherDadosPeticao(abaAtual, codigos[i]);

    console.log(`[etapa-10] Salvando petição (${label})...`);
    await abaAtual.locator('#botaoSalvarPeticaoParaProtocolar').click();
    await abaAtual.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log(`[etapa-10] ${label}: Fechar clicado.`);

    await abaAtual.close();
    await page.bringToFront();
    console.log(`[etapa-10] ${label}: Aba ESAJ fechada. Foco no SIGAD.`);
  }
}

// ── Fluxo por serviço ─────────────────────────────────────────────────────────

function normalizarServico(s) {
  return s.replace(/\./g, '').trim();
}

async function listarServicos(page) {
  const linhas  = page.locator(SEL.SERVICO_LINHAS);
  const count   = await linhas.count();
  const servicos = [];
  for (let i = 0; i < count; i++) {
    const txt = await linhas.nth(i).locator(SEL.SERVICO_ITEM).textContent().catch(() => '');
    const num = txt.trim();
    if (num) servicos.push(num);
  }
  return servicos;
}

async function processarServico(page, context, servicoAlvo = null) {
  // Etapa 1 — Localiza a linha do serviço e abre o dialog
  const linhaServico = servicoAlvo
    ? page.locator(SEL.SERVICO_LINHAS)
        .filter({ has: page.locator(SEL.SERVICO_ITEM).filter({ hasText: servicoAlvo }) })
        .first()
    : page.locator(SEL.SERVICO_LINHAS).first();

  const servico = await linhaServico.locator(SEL.SERVICO_ITEM).textContent().then(t => t.trim());
  await linhaServico.locator(SEL.SERVICO_ITEM).click();
  await aguardarAjax(page);
  await page.locator('[id="formDlgVerServico"]').waitFor({ state: 'visible', timeout: 10000 });

  const extracao = { servico };

  // Etapa 2 — Fases
  const fases = await extrairFases(page);
  if (!fases) return { ok: false, motivo: 'sem fases' };
  extracao.fases = fases;
  salvarExtracao(extracao);

  // Etapa 3 — Documentos (e Laudos, quando a Fase é Laudo)
  const faseELaudo = /LAUDO/i.test(fases.fase);
  const documentosBrutos = await extrairDocumentos(page, fases.temAlvara);

  let documentosEncontrados;
  if (faseELaudo) {
    // O documento principal (Laudo) não aparece em Documentos — vem da aba Laudos.
    // Com Alvará, ele é identificado por tipoDocumento (não pela posição — a linha
    // mais recente em Documentos pode ser um doc antigo/irrelevante de outra fase).
    const alvara = fases.temAlvara
      ? documentosBrutos.filter(d => d.tipoDocumento.toUpperCase().includes('ALVARA'))
      : [];
    const laudos = await extrairAbaLaudos(page);
    documentosEncontrados = laudos[0] ? [laudos[0], ...alvara] : alvara;
  } else {
    documentosEncontrados = documentosBrutos;
  }

  const confere = conferirDocumentos(fases.documentosEsperados, documentosEncontrados);
  extracao.documentos = { encontrados: documentosEncontrados, confere };
  salvarExtracao(extracao);

  if (!confere) {
    console.warn('[etapa-3] Documentos não conferem com a Fase — encaminhando com subfase PROTOCOLAR.');
    console.warn(`  Esperado:   ${JSON.stringify(fases.documentosEsperados)}`);
    console.warn(`  Encontrado: ${JSON.stringify(documentosEncontrados)}`);
    await page.locator(SEL.TAB_DADOS).click();
    await aguardarAjax(page);
    await encaminharServico(page, { nome: ENCAMINHAR_NOME, observacao: fases.observacao, subfase: 'PROTOCOLAR' });
    extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'PROTOCOLAR', observacao: fases.observacao };
    salvarExtracao(extracao);
    await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);
    return { ok: false, motivo: 'documentos não conferem', ...extracao };
  }

  console.log('[etapa-3] Documentos conferem. Prosseguindo para etapa 4...');

  // Etapa 4 — Dados Básicos → ESAJ
  const { esajAba, numeroProcesso } = await abrirProcessoNoESAJ(page, context);
  extracao.processoUrl = esajAba.url();
  extracao.numeroProcesso = numeroProcesso;
  salvarExtracao(extracao);

  // Etapa 5 — Localizar pasta e extrair cabeçalho do PDF
  let pastaServico, pastaRecente, cabecalhoDoc;
  try {
    ({ pastaServico, pastaRecente } = localizarPastaServico(extracao.servico));
    extracao.pasta = { servico: pastaServico, recente: pastaRecente };
    cabecalhoDoc = await extrairCabecalhoDocumento(pastaRecente, fases.documentosEsperados[0]);
    extracao.cabecalhoDoc = cabecalhoDoc;
    salvarExtracao(extracao);
  } catch (err) {
    console.warn(`[etapa-5] ${err.message} — encaminhando com subfase PROTOCOLAR.`);
    await esajAba.close().catch(() => {});
    await encaminharServico(page, { nome: ENCAMINHAR_NOME, observacao: fases.observacao, subfase: 'PROTOCOLAR' });
    extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'PROTOCOLAR', observacao: fases.observacao };
    salvarExtracao(extracao);
    await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);
    return { ok: false, motivo: err.message, ...extracao };
  }

  // Etapa 6 — Extrair partes e cabeçalho do ESAJ
  console.log('[etapa-6] Extraindo partes e cabeçalho do ESAJ...');
  const [resultadoPartes, cabecalhoESAJ] = await Promise.all([
    extrairPartesDoESAJ(esajAba),
    extrairCabecalhoDoESAJ(esajAba, numeroProcesso),
  ]);
  extracao.esaj = { partes: resultadoPartes.partes, todasPartes: resultadoPartes.todasPartes, cabecalho: cabecalhoESAJ };
  salvarExtracao(extracao);
  console.log(`[etapa-6] Partes: ${JSON.stringify(resultadoPartes.partes)}`);
  console.log(`[etapa-6] Cabeçalho ESAJ: ${JSON.stringify(cabecalhoESAJ)}`);

  // Etapa 7 — Conferir dados do documento com ESAJ
  const conferencia = conferirEtapa7(extracao.cabecalhoDoc, extracao.esaj);
  extracao.conferencia = conferencia;
  salvarExtracao(extracao);

  if (!conferencia.ok) {
    let divergenciaSuperada = false;

    const todasPartes = extracao.esaj.todasPartes;
    if (todasPartes) {
      console.log('[etapa-7.1] tableTodasPartes disponível — tentando fallback de partes...');
      divergenciaSuperada = conferencia.campos.every(r => {
        if (r.bate) return true;
        if (r.campo !== 'autor' && r.campo !== 'reu') return false;
        const role = r.campo === 'autor' ? 'AUTOR' : 'RÉU';
        const candidatos = todasPartes[role] ?? [];
        const bateu = candidatos.some(cand => nomesBatem(r.doc, cand));
        console.log(`  [etapa-7.1] ${r.campo}: doc="${r.doc}" candidatos=[${candidatos.join(' | ')}] → ${bateu ? '[OK]' : '[XX]'}`);
        return bateu;
      });
      console.log(`[etapa-7.1] Fallback: ${divergenciaSuperada ? 'match encontrado — prosseguindo' : 'sem match'}.`);
    }

    if (!divergenciaSuperada) {
      console.warn('[etapa-7] Dados divergem — notificação por e-mail pendente (configurar GMAIL_USUARIO/GMAIL_APP_PASSWORD).');
      // const responsavel = extracao.documentos.encontrados[0]?.responsavel ?? '';
      // await notificarDivergencia(responsavel, conferencia, extracao.servico);
      await esajAba.close();
      await page.bringToFront();
      console.warn('[etapa-7] Dados divergem — encaminhando com subfase PROTOCOLAR.');
      await encaminharServico(page, { nome: ENCAMINHAR_NOME, observacao: fases.observacao, subfase: 'PROTOCOLAR' });
      extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'PROTOCOLAR', observacao: fases.observacao };
      salvarExtracao(extracao);
      await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
      await aguardarAjax(page);
      return { ok: false, motivo: 'dados divergem entre documento e ESAJ', ...extracao };
    }
  }

  console.log('[etapa-7] Dados conferem. Prosseguindo para Etapas 8-10 (peticionar)...');

  // Etapas 8-10 — protocolo no ESAJ; peticionarNoESAJ fecha cada aba ao fim
  await peticionarNoESAJ(esajAba, page, context, {
    pastaRecente:        extracao.pasta.recente,
    documentosEsperados: fases.documentosEsperados,
    temAlvara:           fases.temAlvara,
    fase:                fases.fase,
    subfase:             fases.subfase,
  });
  extracao.peticao = { ok: true };
  salvarExtracao(extracao);

  // Etapa 11 — Encaminhar
  await encaminharServico(page, {
    nome:      ENCAMINHAR_NOME,
    observacao: fases.observacao,
  });
  extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'AGUARDAR PROTOCOLO', observacao: fases.observacao };
  salvarExtracao(extracao);

  // Retorna à home para que o próximo serviço seja encontrado na tabela
  console.log('[etapa-11] Redirecionando para home do SIGAD...');
  await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
  await aguardarAjax(page);

  return { ok: true, ...extracao };
}

// ── Modo etapa11 — roda só o encaminhamento a partir de extracao-protocolo.json ─

async function abrirServicoESigad(page, servico) {
  const linhaServico = page.locator(SEL.SERVICO_LINHAS)
    .filter({ has: page.locator(SEL.SERVICO_ITEM).filter({ hasText: servico }) })
    .first();
  await linhaServico.locator(SEL.SERVICO_ITEM).click();
  await aguardarAjax(page);
  await page.locator('[id="formDlgVerServico"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(SEL.TAB_DADOS).click();
  await aguardarAjax(page);
}

async function mainEtapa11() {
  const temBatch    = fs.existsSync(ENCAMINHAR_FILE);
  const temExtracao = fs.existsSync(EXTRACAO_FILE);

  if (!temBatch && !temExtracao) {
    throw new Error(
      '[etapa-11] Nenhum arquivo de entrada encontrado.\n' +
      `  Batch:    crie ${ENCAMINHAR_FILE} com [{ "servico": "XX.XXX", "observacao": "..." }]\n` +
      `  Retomada: execute o fluxo completo primeiro (gera ${EXTRACAO_FILE}).`
    );
  }

  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  try {
    console.log('[etapa-11] Verificando sessão SIGAD...');
    await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    const jaLogado = await page.locator('span.menuitem-text:has-text("Painéis")').isVisible().catch(() => false);
    if (!jaLogado) {
      console.log('[etapa-11] Sessão expirada — realizando login...');
      await fazerLogin(page, context);
    }

    if (temBatch) {
      // ── Modo batch: encaminhar.json ──────────────────────────────────────────
      let pendentes = JSON.parse(fs.readFileSync(ENCAMINHAR_FILE, 'utf-8'));
      if (!Array.isArray(pendentes) || pendentes.length === 0) {
        throw new Error('[etapa-11] encaminhar.json está vazio ou inválido.');
      }
      console.log(`[etapa-11] Batch: ${pendentes.length} serviço(s) a encaminhar.`);

      while (pendentes.length > 0) {
        const { servico, observacao, subfase = 'AGUARDAR PROTOCOLO' } = pendentes[0];
        if (!servico || !observacao) {
          throw new Error(`[etapa-11] Entrada inválida em encaminhar.json: ${JSON.stringify(pendentes[0])}`);
        }
        console.log(`\n[etapa-11] Serviço ${servico} — subfase "${subfase}"...`);

        await abrirServicoESigad(page, servico);
        await encaminharServico(page, { nome: ENCAMINHAR_NOME, observacao, subfase });
        console.log(`[etapa-11] Serviço ${servico} encaminhado.`);

        pendentes = pendentes.slice(1);
        fs.writeFileSync(ENCAMINHAR_FILE, JSON.stringify(pendentes, null, 2), 'utf-8');

        if (pendentes.length > 0) {
          await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
          await aguardarAjax(page);
        }
      }

      fs.unlinkSync(ENCAMINHAR_FILE);
      console.log('[etapa-11] Todos os serviços encaminhados. encaminhar.json removido.');

    } else {
      // ── Modo retomada: extracao-protocolo.json ───────────────────────────────
      const extracao = JSON.parse(fs.readFileSync(EXTRACAO_FILE, 'utf-8'));
      const { servico, fases } = extracao;
      if (!servico || !fases?.observacao) {
        throw new Error('[etapa-11] extracao-protocolo.json não contém servico/fases.observacao.');
      }
      console.log(`[etapa-11] Retomando encaminhamento do serviço ${servico} (obs: "${fases.observacao}")`);

      await abrirServicoESigad(page, servico);
      await encaminharServico(page, { nome: ENCAMINHAR_NOME, observacao: fases.observacao });
      console.log('[etapa-11] Encaminhamento concluído.');
    }

  } finally {
    console.log('\n[etapa-11] Concluído. Feche o browser quando terminar.');
    await new Promise(() => {});
  }
}

// ── Fluxo principal ───────────────────────────────────────────────────────────

async function main() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  try {
    // 1. Login ESAJ
    console.log('[auto-protocolar] Verificando sessão ESAJ...');
    await loginEsaj(context, page);

    // 2. Login SIGAD
    console.log('[auto-protocolar] Verificando sessão SIGAD...');
    await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    const jaLogado = await page.locator('span.menuitem-text:has-text("Painéis")').isVisible().catch(() => false);
    if (!jaLogado) {
      console.log('[auto-protocolar] Sessão SIGAD expirada — realizando login...');
      await fazerLogin(page, context);
    } else {
      console.log('[auto-protocolar] Sessão SIGAD ativa.');
    }

    // 3. Carregar ou criar pending.json
    let pendentes;
    if (fs.existsSync(PENDING_FILE)) {
      pendentes = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      console.log(`[auto-protocolar] Retomando ${pendentes.length} serviços de pending.json: ${JSON.stringify(pendentes)}`);
    } else {
      const todos = await listarServicos(page);
      pendentes = todos.filter(s => !SERVICOS_EXCLUIDOS.includes(normalizarServico(s)));
      fs.writeFileSync(PENDING_FILE, JSON.stringify(pendentes, null, 2), 'utf-8');
      const excluidos = todos.length - pendentes.length;
      console.log(`[auto-protocolar] ${pendentes.length} serviços em pending.json (${excluidos} excluído${excluidos !== 1 ? 's' : ''}).`);
      console.log(`[auto-protocolar] Pendentes: ${JSON.stringify(pendentes)}`);
    }

    // 4. Loop principal
    for (const servicoAlvo of [...pendentes]) {
      console.log(`\n[auto-protocolar] ══ Processando: ${servicoAlvo} ══`);
      const resultado = await processarServico(page, context, servicoAlvo);
      console.log('[auto-protocolar] Resultado:', JSON.stringify(resultado, null, 2));

      pendentes = pendentes.filter(s => s !== servicoAlvo);
      fs.writeFileSync(PENDING_FILE, JSON.stringify(pendentes, null, 2), 'utf-8');
      console.log(`[auto-protocolar] ${servicoAlvo} concluído. ${pendentes.length} restante(s).`);
    }

    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
    console.log('[auto-protocolar] Todos os serviços processados. pending.json removido.');

  } catch (err) {
    console.error('[auto-protocolar] Erro:', err.message);
    console.error(err.stack);
    console.log('[auto-protocolar] pending.json preservado para retomada.');
  } finally {
    console.log('\n[auto-protocolar] Concluído. Feche o browser quando terminar.');
    await new Promise(() => {});
  }
}

if (require.main === module) {
  const modo = process.argv[2];
  const fn   = modo === 'etapa11' ? mainEtapa11 : main;
  fn().catch(err => {
    console.error('[auto-protocolar] Erro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  normalizarServico,
  listarServicos,
  processarServico,
  extrairFases,
  extrairDocumentos,
  extrairAbaLaudos,
  conferirDocumentos,
  abrirProcessoNoESAJ,
  localizarPastaServico,
  extrairCabecalhoDocumento,
  extrairPartesDoESAJ,
  extrairCabecalhoDoESAJ,
  encaminharServico,
  conferirEtapa7,
  resolverCodigoClassificacao,
  abrirFormularioPeticao,
  importarDocumentoESAJ,
  tratarSugestaoClassificacao,
  preencherDadosPeticao,
  peticionarNoESAJ,
};
