// crawler.js modificado

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fazerLogin } = require('./auth');

const AUTH_FILE = path.resolve(__dirname, '../../data/auth.json');
const RESULTS_FILE = path.resolve(__dirname, '../../data/resultados.json');
const LOGIN_URL  = 'https://sistemas.vcpericia.com.br/sigad/';
const TARGET_URL = 'https://sistemas.vcpericia.com.br/sigad/usuario/atos/index.xhtml';

// XPath helper — JSF IDs com colons funcionam melhor com XPath do que CSS
const byId = (id) => `[id="${id}"]`;
const xpById = (id) => `//*[@id="${id}"]`;

// Clona o perfil real do Chrome (com login Google e extensões) para o diretório de automação.
// Executado apenas na primeira vez; para re-clonar, delete data/chrome-profile.
function clonarPerfilChrome(destDir) {
  const localStateDest = path.join(destDir, 'Local State');
  if (fs.existsSync(localStateDest)) return;

  const origemDir  = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  const profileSrc = path.join(origemDir, process.env.CHROME_PROFILE || 'Default');
  const profileDst = path.join(destDir, 'Default');

  console.log('[crawler] Clonando perfil Chrome (primeira execução)...');
  fs.mkdirSync(destDir, { recursive: true });
  try { fs.copyFileSync(path.join(origemDir, 'Local State'), localStateDest); } catch {}
  try {
    execSync(
      `robocopy "${profileSrc}" "${profileDst}" /E /XD "Cache" "Code Cache" "GPUCache" "Service Worker" "CacheStorage" /XF "*.tmp" /NJH /NJS /NFL /NDL`,
      { stdio: 'ignore' }
    );
  } catch (e) {
    if (e.status > 7) throw new Error(`Falha ao clonar perfil Chrome: ${e.message}`);
  }
  console.log('[crawler] Perfil clonado.');
}

// Mata só os processos chrome.exe / chrome_crashpad_handler.exe cuja linha de comando
// referencia o userDataDir da automação — não afeta janelas do Chrome pessoal do usuário,
// que rodam sobre um user-data-dir diferente (perfil real, não o clone).
function matarChromeDoPerfil(userDataDir) {
  const script = `
$dir = '${userDataDir.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='chrome_crashpad_handler.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { stdio: 'ignore' });
  } catch {}
}

async function abrirBrowser() {
  const userDataDir = path.resolve(__dirname, '../../data/chrome-profile');

  // Clona o perfil real na primeira execução (login Google + extensões)
  clonarPerfilChrome(userDataDir);

  // Encerra APENAS os processos chrome.exe/crashpad que estejam usando o perfil de automação
  // (data/chrome-profile), para liberar o SingletonLock sem fechar o Chrome pessoal do usuário
  // (que roda sobre outro user-data-dir e não aparece no filtro abaixo).
  matarChromeDoPerfil(userDataDir);

  // Aguarda Chrome encerrar completamente antes de lançar (evita "sessão existente")
  const tInicio = Date.now();
  while (Date.now() - tInicio < 10000) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const lista = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
      if (!lista.toLowerCase().includes('chrome.exe')) break;
    } catch { break; }
  }

  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.unlinkSync(path.join(userDataDir, lock)); } catch {}
  }

  console.log('[crawler] Iniciando Chrome...');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    slowMo: 80,
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--no-sandbox',
    ],
  });

  if (fs.existsSync(AUTH_FILE)) {
    try {
      const { cookies } = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        console.log('[crawler] Cookies SIGAD carregados de auth.json.');
      }
    } catch {
      console.warn('[crawler] auth.json inválido — iniciando sem sessão.');
    }
  }

  return { browser: { close: async () => context.close() }, context };

}

async function garantirSessao(page, context) {
  // Abre sempre pela URL base — a URL não muda após o login (confirmado pelo usuário)
  console.log('[crawler] Abrindo sistema...');
  await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 60000 });

  // O sinal de sessão ativa é o menu aparecer — "Painéis" só existe para usuários logados
  const menuPaineis = page.locator('span.menuitem-text:has-text("Painéis")');
  const jaLogado = await menuPaineis.isVisible().catch(() => false);

  if (!jaLogado) {
    console.log('[crawler] Sessão expirada. Realizando login automático...');
    await fazerLogin(page, context);
  } else {
    console.log('[crawler] Sessão já ativa.');
  }

  // Login confirmado — navega para a rota da tabela
  console.log('[crawler] Redirecionando para a tabela...');
  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 });
  console.log('[crawler] Tabela acessada.');
}

async function aguardarAjax(page) {
  // Aguarda a fila interna do PrimeFaces esvaziar antes de networkidle,
  // pois o PrimeFaces pode manter conexões keepalive que impedem o networkidle.
  await page.waitForFunction(
    () => typeof window.PrimeFaces === 'undefined' || window.PrimeFaces.ajax.Queue.isEmpty(),
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function debugPagina(page, label) {
  const url = page.url();
  const screenshotPath = path.resolve(__dirname, `../../data/debug_${label}.png`);
  const debugPath = path.resolve(__dirname, `../../data/debug_${label}.json`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const info = await page.evaluate(() => {
    const allIds = [...document.querySelectorAll('[id]')]
      .map((el) => ({
        id: el.id,
        tag: el.tagName.toLowerCase(),
        visible: el.offsetParent !== null || el.getBoundingClientRect().width > 0,
        display: getComputedStyle(el).display,
        visibility: getComputedStyle(el).visibility,
      }))
      .filter((el) => el.id.includes('tabela') || el.id.includes('j_idt381'));
    return {
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500) ?? '',
      tabelaElements: allIds,
    };
  }).catch((e) => ({ error: e.message }));

  fs.writeFileSync(debugPath, JSON.stringify({ url, ...info }, null, 2));
  console.log(`[crawler][debug] URL: ${url}`);
  console.log(`[crawler][debug] Título: ${info.title ?? '?'}`);
  console.log(`[crawler][debug] Elementos tabela/j_idt381 encontrados: ${info.tabelaElements?.length ?? 0}`);
  console.log(`[crawler][debug] Screenshot: ${screenshotPath}`);
  console.log(`[crawler][debug] JSON:       ${debugPath}`);
}

async function aplicarFiltros(page) {
  const labelCandidatos = [
    'formServico:tabela:j_idt345_label',
    'formServico:tabela:j_idt381_label',
  ];

  let labelId = null;
  for (const id of labelCandidatos) {
    try {
      await page.waitForSelector(`[id="${id}"]`, { state: 'visible', timeout: 5000 });
      labelId = id;
      break;
    } catch {}
  }

  if (!labelId) {
    console.error('[crawler] Timeout aguardando label do filtro Situação. Capturando diagnóstico...');
    await debugPagina(page, 'filtro_timeout');
    throw new Error('Filtro Situação: nenhum label encontrado (j_idt345_label / j_idt381_label)');
  }

  console.log('[crawler] Tabela encontrada. Aplicando filtros...');

  const panelId = labelId.replace('_label', '_panel');
  await page.locator(byId(labelId)).click();
  const panel = page.locator(byId(panelId));
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  await panel.locator(`li[data-label="Cadastro"], li:has-text("Cadastro")`).first().click();

  await page.locator('.ui-datatable-loading').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await aguardarAjax(page);
  console.log('[crawler] Filtro "Situação = Cadastro" aplicado.');
}

// Converte "09/jun./2026" → "09/06/2026"
const MESES = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
function normalizarData(str) {
  if (!str) return str;
  return str.replace(/(\d{2})\/([a-z]{3})\.?\/(\d{4})/i, (_, d, m, y) => {
    const num = MESES[m.toLowerCase()];
    return num ? `${d}/${String(num).padStart(2, '0')}/${y}` : str;
  });
}

async function extrairPagina(page) {
  const rows = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#formServico\\:tabela_head th')];
    const teorIdx = ths.findIndex((th) => th.id === 'formServico:tabela:j_idt337' || th.id === 'formServico:tabela:j_idt373');
    const dispIdx = ths.findIndex((th) => th.id === 'formServico:tabela:j_idt321' || th.id === 'formServico:tabela:j_idt357');

    // Remove spans de título responsivo (.ui-column-title) e retorna o texto limpo do td
    function textoDaCelula(td) {
      if (!td) return '';
      const clone = td.cloneNode(true);
      clone.querySelectorAll('.ui-column-title').forEach((el) => el.remove());
      return clone.textContent.trim();
    }

    return [...document.querySelectorAll('#formServico\\:tabela_data tr')]
      .map((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const span = cells[0]?.querySelector('a span');
        if (!span) return null;
        const servico = span.textContent.trim();
        const teor = teorIdx >= 0 ? textoDaCelula(cells[teorIdx]) : '';
        const disponibilizacao = dispIdx >= 0 ? textoDaCelula(cells[dispIdx]) : '';
        return { servico, teor, disponibilizacao };
      })
      .filter((v) => v !== null && v.servico !== '');
  });
  return rows.map((r) => ({ ...r, disponibilizacao: normalizarData(r.disponibilizacao) }));
}

async function extrairTodasPaginas(page) {
  const itensTotal = [];
  let pagina = 1;

  while (true) {
    console.log(`[crawler] Lendo página ${pagina}...`);
    const itens = await extrairPagina(page);
    itensTotal.push(...itens);

    // Escopa no paginator do topo para evitar duplicatas (top + bottom = strict mode error).
    // Usa .ui-paginator-next (botão "próxima"), não .ui-paginator-page (números de página).
    const proximaBtn = page
      .locator('[id="formServico:tabela_paginator_top"] .ui-paginator-next:not(.ui-state-disabled)');
    const temProxima = (await proximaBtn.count()) > 0;
    if (!temProxima) break;

    await proximaBtn.click();
    await aguardarAjax(page);
    pagina++;
  }
  console.log(`ITENS TOTAL: ${itensTotal}`);
  return itensTotal;
}

async function extrairDados() {
  const { browser, context } = await abrirBrowser();
  const page = await context.newPage();

  try {
    await garantirSessao(page, context);
    await aplicarFiltros(page);

    const itens = await extrairTodasPaginas(page);

    const TEOR_FILTRO = '';
    const filtrados = itens.filter((item) => item.teor.toLowerCase().includes(TEOR_FILTRO));
    console.log(`[crawler] ${itens.length} linha(s) Cadastro; ${filtrados.length} com Teor contendo "${TEOR_FILTRO}".`);

    const dados = filtrados.map((item, idx) => ({ id: idx + 1, servico: item.servico, teor: item.teor, disponibilizacao: item.disponibilizacao }));

    fs.writeFileSync(RESULTS_FILE, JSON.stringify(dados, null, 2));
    console.log(`[crawler] ${dados.length} item(s) extraído(s) → data/resultados.json`);

    return dados;
  } finally {
    await browser.close();
  }
}

// Abre o browser, garante sessão e aplica filtros — retorna { browser, context, page }
// sem fechar o browser, para uso por outros módulos (ex: recorder.js, api-site.js).
async function prepararPagina() {
  const { browser, context } = await abrirBrowser();
  // Reusa aba inicial do launchPersistentContext em vez de criar uma nova
  const page = context.pages()[0] ?? await context.newPage();
  await garantirSessao(page, context);
  await aplicarFiltros(page);
  return { browser, context, page };
}

// Execução standalone
if (require.main === module) {
  extrairDados()
    .then((dados) => {
      console.log('\n[crawler] Resultado:');
      console.log(JSON.stringify(dados, null, 2));
    })
    .catch((err) => {
      console.error('[crawler] Erro:', err.message);
      process.exit(1);
    });
}

module.exports = { extrairDados, prepararPagina, normalizarData, abrirBrowser, garantirSessao, aplicarFiltros };