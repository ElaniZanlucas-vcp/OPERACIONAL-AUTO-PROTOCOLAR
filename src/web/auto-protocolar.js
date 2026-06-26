// auto-protocolar.js — Etapas 2-4 e 11: Fases → Documentos → Dados Básicos → ESAJ → Encaminhar

'use strict';

const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
// const nodemailer       = require('nodemailer');
const { abrirBrowser } = require('./crawler');
const { fazerLogin }   = require('./auth');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const SIGAD_LOGIN_URL = 'https://sistemas.vcpericia.com.br/sigad/';
const ESAJ_LOGIN_URL  = 'https://esaj.tjms.jus.br/sajcas/login/aba-certificado';
const EXTRACAO_FILE    = path.resolve(__dirname, '../../data/extracao-protocolo.json');
const TRABALHOS_FINAIS = process.env.TRABALHOS_FINAIS;

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
      .map((row, idx) => ({
        documento:   valorCelula(celulaPorTitulo(row, 'Documento')),
        responsavel: idx === 0 ? valorCelula(celulaPorTitulo(row, 'Responsável')) : null,
      }));
  }, { seletorLinhas: SEL.DOCS_LINHAS, qtd });

  console.log(`[etapa-3] Docs encontrados (${documentos.length}): ${JSON.stringify(documentos)}`);
  return documentos;
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

  const contagemCompleta = new Map();
  if (linhasCompletas) {
    for (const { label } of linhasCompletas) {
      const labelNorm = label.replace(/[.:]$/, '').trim();
      if (/^Advogad[ao]s?$/i.test(labelNorm)) continue;
      const role = classificarRoleESAJ(labelNorm);
      if (!role) continue;
      contagemCompleta.set(role, (contagemCompleta.get(role) ?? 0) + 1);
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
    const total = contagemCompleta.get(participacao) ?? 0;
    const sufixo = total > 1 ? ' E OUTROS' : '';
    partes.push({ participacao, nome: nome + sufixo });
  }

  return partes;
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
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toUpperCase()
    .replace(/\/[A-Z]{2,3}\.?\s*$/, '')  // remove /MS. /MT. /SP. no final (foro)
    .replace(/\//g, ' ')                  // barras restantes → espaço
    .replace(/[.,]/g, '')                 // remove pontuação
    .replace(/\b0+(\d+[ªº°])/g, '$1')    // 02ª → 2ª (apenas ordinais, não afeta n° processo)
    .replace(/\s+/g, ' ')
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
//     `Por favor, verifique e corrija o documento. Após a correção, reprocessaremos automaticamente.`,
//     ``,
//     `Obrigada!`,
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

// ── Etapas 8-10: Protocolar no ESAJ ──────────────────────────────────────────

function resolverCodigoClassificacao(fase, subfase) {
  const f = fase.toUpperCase().trim();
  const s = subfase.toUpperCase().trim();
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
  console.log('[etapa-8] Preenchendo dados da petição...');

  // 1. PETICIONANTE — abrir dropdown → digitar → selecionar ÉRIKA → remover tag anterior
  console.log('[etapa-8] Peticionante...');
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
  console.log('[etapa-8] Peticionante ÉRIKA selecionada.');

  // 2. CLASSIFICAÇÃO — sem arquivo ainda, não há sugestão; "Classificar" visível normalmente
  console.log('[etapa-8] Classificação...');
  await esajAba.locator('span.va-m:has-text("Classificar")')
    .waitFor({ state: 'visible', timeout: 15000 });
  await esajAba.locator('span.va-m:has-text("Classificar")').click();
  await esajAba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)')
    .waitFor({ state: 'visible', timeout: 5000 });
  await esajAba.locator('span.ui-select-placeholder.text-muted:not(.ng-hide)').click();
  await esajAba.locator('#selectClasseIntermediaria')
    .pressSequentially(String(codigo), { delay: 80 });
  const opcaoCodigo = esajAba.locator('span.selecao-classe--nome').filter({ hasText: String(codigo) });
  await opcaoCodigo.waitFor({ state: 'visible', timeout: 8000 });
  await opcaoCodigo.first().click();
  await esajAba.locator('span.glyph.glyph-chevron-up').click();
  console.log(`[etapa-8] Classificação ${codigo} selecionada.`);

  // 3. SOLICITANTE: clicar em "Incluir parte" no card da empresa (identificado pelo CNPJ)
  console.log('[etapa-8] Solicitante...');
  const cardSolicitante = esajAba.locator('[id^="cardParte_"]').filter({ hasText: '01.088.089/0001-52' });
  await cardSolicitante.waitFor({ state: 'visible', timeout: 10000 });
  await cardSolicitante.locator('.botao-incluir-polo').click();

  console.log('[etapa-8] Dados preenchidos.');
}


async function importarDocumentoESAJ(esajAba, filePath) {
  console.log(`[etapa-9] Enviando arquivo: ${path.basename(filePath)}`);
  // Dois botões com id "botaoAdicionarDocumento" — diferencia por aria-label
  const btnDoc = esajAba.locator('[aria-label="Adicionar arquivos elaborados"]');
  await btnDoc.waitFor({ state: 'visible', timeout: 10000 });
  const [fileChooser] = await Promise.all([
    esajAba.waitForEvent('filechooser'),
    btnDoc.click(),
  ]);
  await fileChooser.setFiles(filePath);
  await new Promise(r => setTimeout(r, 3000));
  console.log('[etapa-9] Arquivo carregado.');
}

async function peticionarNoESAJ(esajAba, { pastaRecente, documentosEsperados, temAlvara, fase, subfase }) {
  const codigo = resolverCodigoClassificacao(fase, subfase);
  console.log(`[peticionar] Fase: ${fase} | Subfase: ${subfase} | Código: ${codigo}`);

  const docs = temAlvara && documentosEsperados.length > 1
    ? [documentosEsperados[0], documentosEsperados[1]]
    : [documentosEsperados[0]];

  for (let i = 0; i < docs.length; i++) {
    const docName  = docs[i];
    const ehAlvara = i > 0;
    const codigoDoc = ehAlvara ? 38380 : codigo;
    const filePath  = path.join(pastaRecente, docName + '.pdf');

    console.log(`\n[peticionar] ${i + 1}/${docs.length} — ${ehAlvara ? 'Alvará' : 'Documento principal'} (${docName})`);

    await abrirFormularioPeticao(esajAba);            // clica Peticionar → abre formulário
    await preencherDadosPeticao(esajAba, codigoDoc);  // PETICIONANTE → CLASSIFICAÇÃO → SOLICITANTE
    await importarDocumentoESAJ(esajAba, filePath);   // upload do arquivo

    const ultimoDoc = i === docs.length - 1;
    if (!ultimoDoc) {
      console.log('[etapa-10] Redirecionando para capa do processo (loop Alvará)...');
      await esajAba.locator('span.numeroProcesso').first().click();
      await esajAba.locator('#dropdownCriarPeticaoInicial').waitFor({ state: 'visible', timeout: 15000 });
      console.log('[etapa-10] Capa carregada — iniciando loop Alvará.');
    } else {
      console.log('[etapa-10] Aguardando 10s antes de fechar (modo teste)...');
      await new Promise(r => setTimeout(r, 10000));
      await esajAba.locator('#botaoVoltarListagemConsulta').click();
      await esajAba.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      console.log('[etapa-10] Formulário fechado.');
    }
  }
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
  const { esajAba, numeroProcesso } = await abrirProcessoNoESAJ(page, context);
  extracao.processoUrl = esajAba.url();
  extracao.numeroProcesso = numeroProcesso;
  salvarExtracao(extracao);

  // Etapa 5 — Localizar pasta e extrair cabeçalho do PDF
  const { pastaServico, pastaRecente } = localizarPastaServico(extracao.servico);
  extracao.pasta = { servico: pastaServico, recente: pastaRecente };
  const cabecalhoDoc = await extrairCabecalhoDocumento(pastaRecente, fases.documentosEsperados[0]);
  extracao.cabecalhoDoc = cabecalhoDoc;
  salvarExtracao(extracao);

  // Etapa 6 — Extrair partes e cabeçalho do ESAJ
  console.log('[etapa-6] Extraindo partes e cabeçalho do ESAJ...');
  const [partesESAJ, cabecalhoESAJ] = await Promise.all([
    extrairPartesDoESAJ(esajAba),
    extrairCabecalhoDoESAJ(esajAba, numeroProcesso),
  ]);
  extracao.esaj = { partes: partesESAJ, cabecalho: cabecalhoESAJ };
  salvarExtracao(extracao);
  console.log(`[etapa-6] Partes: ${JSON.stringify(partesESAJ)}`);
  console.log(`[etapa-6] Cabeçalho ESAJ: ${JSON.stringify(cabecalhoESAJ)}`);

  // Etapa 7 — Conferir dados do documento com ESAJ
  const conferencia = conferirEtapa7(extracao.cabecalhoDoc, extracao.esaj);
  extracao.conferencia = conferencia;
  salvarExtracao(extracao);

  if (!conferencia.ok) {
    console.warn('[etapa-7] Dados divergem — notificação por e-mail pendente (configurar GMAIL_USUARIO/GMAIL_APP_PASSWORD).');
    // const responsavel = extracao.documentos.encontrados[0]?.responsavel ?? '';
    // await notificarDivergencia(responsavel, conferencia, extracao.servico);
    await esajAba.close();
    await page.bringToFront();
    return { ok: false, motivo: 'dados divergem entre documento e ESAJ', ...extracao };
  }

  console.log('[etapa-7] Dados conferem. Prosseguindo para Etapas 8-10 (peticionar)...');

  // Etapas 8-10 — protocolo no ESAJ (aba ainda aberta)
  await peticionarNoESAJ(esajAba, {
    pastaRecente:        extracao.pasta.recente,
    documentosEsperados: fases.documentosEsperados,
    temAlvara:           fases.temAlvara,
    fase:                fases.fase,
    subfase:             fases.subfase,
  });
  extracao.peticao = { ok: true };
  salvarExtracao(extracao);

  // Fecha a aba ESAJ e retorna foco ao SIGAD
  await esajAba.close();
  await page.bringToFront();

  // TODO: Etapa 11 — Encaminhar
  // await encaminharServico(page, {
  //   nome: ENCAMINHAR_NOME,
  //   observacao: fases.observacao,
  // });
  // extracao.encaminhamento = { nome: ENCAMINHAR_NOME, subfase: 'AGUARDAR PROTOCOLO', observacao: fases.observacao };
  // salvarExtracao(extracao);

  return { ok: true, ...extracao };
}

// ── Fluxo principal ───────────────────────────────────────────────────────────

async function main() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  try {
    // 1. Login ESAJ (certificado) — necessário antes de qualquer consulta ao ESAJ
    console.log('[auto-protocolar] Verificando sessão ESAJ...');
    await loginEsaj(context, page);

    // 2. Login SIGAD — redireciona para a página inicial ao concluir
    console.log('[auto-protocolar] Verificando sessão SIGAD...');
    await page.goto(SIGAD_LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    const jaLogado = await page.locator('span.menuitem-text:has-text("Painéis")').isVisible().catch(() => false);
    if (!jaLogado) {
      console.log('[auto-protocolar] Sessão SIGAD expirada — realizando login...');
      await fazerLogin(page, context);
    } else {
      console.log('[auto-protocolar] Sessão SIGAD ativa.');
    }
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

if (require.main === module) {
  main().catch(err => {
    console.error('[auto-protocolar] Erro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  processarServico,
  extrairFases,
  extrairDocumentos,
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
  preencherDadosPeticao,
  peticionarNoESAJ,
};
