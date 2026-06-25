const fs = require('fs');
const path = require('path');
const { prepararPagina, abrirBrowser, garantirSessao, aplicarFiltros } = require('./crawler');

const RECORD_FILE    = path.resolve(__dirname, '../../data/recording.json');
const INACTIVITY_MS  = 7000;

const ESAJ_LOGIN_URL  = 'https://esaj.tjms.jus.br/sajcas/login/aba-certificado';
const SIGAD_INICIO_URL = 'https://sistemas.vcpericia.com.br/sigad/inicio/index.xhtml';

// --- helpers de automação ---

async function aguardarAjax(page) {
  await page.waitForFunction(
    () => typeof window.PrimeFaces === 'undefined' || window.PrimeFaces.ajax.Queue.isEmpty(),
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

// --- spy de interações ---

async function injectSpy(page) {
  await page.evaluate(() => {
    if (window.__spy_active) return;
    window.__spy_active = true;
    window.__spy_log = window.__spy_log || [];

    function snap(el) {
      return {
        tag:   el.tagName?.toLowerCase() ?? null,
        id:    el.id || null,
        cls:   typeof el.className === 'string' ? el.className.trim().slice(0, 120) : null,
        text:  el.textContent?.trim().slice(0, 120) ?? null,
        value: el.value ?? null,
        label: el.getAttribute('data-label') ?? null,
        name:  el.name ?? null,
      };
    }

    document.addEventListener('click',  (e) => window.__spy_log.push({ type: 'click',  t: Date.now(), el: snap(e.target) }), true);
    document.addEventListener('change', (e) => window.__spy_log.push({ type: 'change', t: Date.now(), el: snap(e.target) }), true);
    document.addEventListener('input',  (e) => window.__spy_log.push({ type: 'input',  t: Date.now(), el: snap(e.target) }), true);
  });
}

async function captureTableStructure(page) {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('thead th')];
    return ths.map((th, idx) => ({
      idx,
      id:            th.id || null,
      text:          th.textContent?.trim().slice(0, 80) ?? null,
      filterInputId: th.querySelector('input[id]')?.id ?? null,
      filterSelectId: th.querySelector('select[id], [id$="_input"]')?.id ?? null,
    }));
  }).catch(() => []);
}

// --- loop de gravação genérico ---

async function iniciarGravacao(page, browser, contexto, urlInicial) {
  await injectSpy(page);

  const recording = {
    context:      contexto,
    navigations:  [{ t: Date.now(), url: urlInicial }],
    interactions: [],
    tableStructure: null,
  };

  let lastActivity = Date.now();
  let hasInteracted = false;
  let done = false;

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    recording.navigations.push({ t: Date.now(), url });
    console.log(`[recorder] nav → ${url}`);
    try {
      await page.waitForLoadState('domcontentloaded');
      await injectSpy(page);
    } catch {}
  });

  const poll = setInterval(async () => {
    if (done) return;

    try {
      const events = await page.evaluate(() => {
        const evs = window.__spy_log ?? [];
        window.__spy_log = [];
        return evs;
      });

      if (events.length > 0) {
        recording.interactions.push(...events);
        hasInteracted = true;
        lastActivity = Date.now();

        events.forEach((e) => {
          const el   = e.el;
          const desc = `<${el.tag}${el.id ? ` id="${el.id}"` : ''}> "${(el.text ?? '').slice(0, 60)}"`;
          if (e.type === 'change')     console.log(`[recorder] change → ${desc}  value="${el.value}"`);
          else if (e.type === 'input') console.log(`[recorder] input  → ${desc}  value="${el.value}"`);
          else                         console.log(`[recorder] click  → ${desc}`);
        });
      }
    } catch {}

    if (hasInteracted && Date.now() - lastActivity >= INACTIVITY_MS) {
      clearInterval(poll);
      done = true;

      recording.tableStructure = await captureTableStructure(page).catch(() => null);
      fs.writeFileSync(RECORD_FILE, JSON.stringify(recording, null, 2));

      console.log('\n[recorder] Gravação finalizada.');
      console.log('[recorder] Arquivo salvo em: data/recording.json');
      await browser.close();
    }
  }, 300);
}

// --- abre guia de processo da primeira linha da tabela ---

async function abrirGuiaProcesso(page, context) {
  const colIdx = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#formServico\\:tabela_head th')];
    return ths.findIndex(
      (th) => th.id === 'formServico:tabela:j_idt331' || th.id === 'formServico:tabela:j_idt367'
    );
  });

  if (colIdx < 0) throw new Error('Coluna Processo não encontrada — verifique o ID do th (j_idt331 / j_idt367)');

  const linkProcesso = page
    .locator('#formServico\\:tabela_data tr')
    .first()
    .locator(`td:nth-child(${colIdx + 1}) a`)
    .first();

  const servicoTexto = await page
    .locator('#formServico\\:tabela_data tr')
    .first()
    .textContent()
    .catch(() => '(desconhecido)');

  console.log(`[recorder] Abrindo guia de processo da primeira linha...`);
  console.log(`[recorder] Linha: "${servicoTexto.trim().slice(0, 80)}"`);

  const [novaAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    linkProcesso.click(),
  ]);

  await novaAba.waitForLoadState('domcontentloaded').catch(() => {});
  await aguardarAjax(novaAba);

  return novaAba;
}

// --- modo: guia-processo (padrão) ---

async function modoGuiaProcesso() {
  const { browser, context, page } = await prepararPagina();

  const novaAba = await abrirGuiaProcesso(page, context);

  const urlInicial = novaAba.url();
  console.log(`[recorder] Guia de processo carregada: ${urlInicial}`);

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  [recorder] PRONTO PARA GRAVAR — GUIA DE PROCESSO  ║');
  console.log('║                                                      ║');
  console.log('║  Interaja com as abas (Notas, Partes, Evento etc.)  ║');
  console.log('║  para mapear seletores e IDs dos elementos.          ║');
  console.log(`║  Gravação encerra após ${INACTIVITY_MS / 1000}s sem atividade.       ║`);
  console.log('╚════════════════════════════════════════════════════╝\n');

  await iniciarGravacao(novaAba, browser, 'guia-processo', urlInicial);
}

// --- login ESAJ com certificado (usado internamente pelo recorder) ---

async function loginEsajRecorder(page) {
  const ESAJ_LOGIN = 'https://esaj.tjms.jus.br/sajcas/login/aba-certificado';
  console.log('[recorder] Navegando para login ESAJ...');
  await page.goto(ESAJ_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const url = page.url();
  const naTelaLogin = url.includes('sajcas') || url.includes('/login');
  if (!naTelaLogin) {
    console.log('[recorder] ESAJ já autenticado.');
    return;
  }

  await page.locator('#linkAbaCertificado').click();
  console.log('[recorder] Aba certificado selecionada — aguardando carregamento (10s)...');
  await new Promise((r) => setTimeout(r, 10000));

  console.log('[recorder] Clicando em Entrar...');
  await page.locator('#submitCertificado').click();

  await page.waitForFunction(
    () => !window.location.href.includes('sajcas') && !window.location.href.includes('/login'),
    { timeout: 10000 }
  ).catch(() => console.warn('[recorder] Timeout aguardando redirecionamento pós-login ESAJ.'));

  console.log('[recorder] Login ESAJ concluído.');
}

// --- modo: visualizar-autos (padrão) ---

async function modoVisualizarAutos() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  // 1. Login ESAJ com certificado
  await loginEsajRecorder(page);

  // 2. Login SIGAD + filtros
  await garantirSessao(page, context);
  await aplicarFiltros(page);

  // 3. Abre aba do processo (primeira linha da tabela)
  const esajAba = await abrirGuiaProcesso(page, context);
  console.log(`[recorder] Guia ESAJ aberta: ${esajAba.url()}`);

  // 4. Aguarda e clica em "Visualizar Autos"
  const linkPasta = esajAba.locator('#linkPasta');
  console.log('[recorder] Aguardando #linkPasta...');
  await linkPasta.waitFor({ state: 'visible', timeout: 20000 });
  console.log('[recorder] Clicando em "Visualizar Autos"...');

  const [novaAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    linkPasta.click(),
  ]);

  const paginaGravacao = novaAba ?? esajAba;
  await paginaGravacao.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  const urlInicial = paginaGravacao.url();
  console.log(`[recorder] Visualizar Autos carregado: ${urlInicial}`);

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  [recorder] PRONTO — BAIXAR PROCESSO                       ║');
  console.log('║                                                              ║');
  console.log('║  Clique no botão de download do processo.                   ║');
  console.log(`║  Gravação encerra após ${INACTIVITY_MS / 1000}s sem atividade.                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  await iniciarGravacao(paginaGravacao, browser, 'baixar-processo', urlInicial);
}

// --- modo: esaj-login (certificado digital) ---

async function modoEsajLogin() {
  const { browser, context } = await abrirBrowser();
  const page = await context.newPage();

  console.log(`[recorder] Abrindo página de login ESAJ com certificado...`);
  await page.goto(ESAJ_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const urlInicial = page.url();
  console.log(`[recorder] Página carregada: ${urlInicial}`);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  [recorder] PRONTO — LOGIN ESAJ COM CERTIFICADO DIGITAL      ║');
  console.log('║                                                                ║');
  console.log('║  Clique no botão de certificado e conclua o login.            ║');
  console.log('║  Todas as interações web serão gravadas (não o diálogo do SO).║');
  console.log(`║  Gravação encerra após ${INACTIVITY_MS / 1000}s sem atividade.                ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  await iniciarGravacao(page, browser, 'esaj-login', urlInicial);
}

// Clica em um seletor varrendo todos os frames — espelha o clicarNoFrame do api-site.js
async function clicarNoFrame(page, selector, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const el = frame.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          return frame; // retorna o frame onde o clique ocorreu
        }
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`'${selector}' não ficou visível em nenhum frame após ${timeout}ms`);
}

// --- modo: pasta-digital ---
// Navega automaticamente até logo após o clique em #botaoContinuar e inicia gravação,
// para mapear o que aparece depois (onde #buttonOk deve aparecer).

async function modoPastaDigital() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  // 1. Login ESAJ
  await loginEsajRecorder(page);

  // 2. SIGAD + filtros
  await garantirSessao(page, context);
  await aplicarFiltros(page);

  // 3. Abre processo
  const esajAba = await abrirGuiaProcesso(page, context);
  console.log(`[recorder] ESAJ: ${esajAba.url()}`);

  // 4. Visualizar Autos
  const linkPasta = esajAba.locator('#linkPasta');
  await linkPasta.waitFor({ state: 'visible', timeout: 20000 });
  const [pastaAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    linkPasta.click(),
  ]);
  const paginaPasta = pastaAba ?? esajAba;
  await paginaPasta.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  console.log(`[recorder] Pasta Digital: ${paginaPasta.url()}`);

  // 5. Passos automáticos do wizard até #botaoContinuar
  console.log('[recorder] Clicando #signatario...');
  await clicarNoFrame(paginaPasta, '#signatario', 10000);

  console.log('[recorder] Clicando #selecionarButton...');
  await clicarNoFrame(paginaPasta, '#selecionarButton', 10000);

  console.log('[recorder] Clicando #salvarButton...');
  await clicarNoFrame(paginaPasta, '#salvarButton', 15000);

  console.log('[recorder] Clicando #botaoContinuar...');
  await clicarNoFrame(paginaPasta, '#botaoContinuar', 15000);

  // 6. Inicia gravação — a partir daqui mapear o que aparece (buttonOk / próxima etapa)
  const urlInicial = paginaPasta.url();
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  [recorder] PRONTO — PÓS #botaoContinuar                   ║');
  console.log('║                                                              ║');
  console.log('║  Interaja com o que aparecer na tela para mapear            ║');
  console.log('║  o botão #buttonOk e os passos seguintes.                   ║');
  console.log(`║  Gravação encerra após ${INACTIVITY_MS / 1000}s sem atividade.                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Injeta spy em todos os frames existentes + futuros
  for (const frame of paginaPasta.frames()) {
    await frame.evaluate(() => {
      if (window.__spy_active) return;
      window.__spy_active = true;
      window.__spy_log = window.__spy_log || [];
      function snap(el) {
        return {
          tag: el.tagName?.toLowerCase() ?? null, id: el.id || null,
          cls: typeof el.className === 'string' ? el.className.trim().slice(0, 120) : null,
          text: el.textContent?.trim().slice(0, 120) ?? null,
          value: el.value ?? null, name: el.name ?? null,
        };
      }
      document.addEventListener('click',  (e) => window.__spy_log.push({ type: 'click',  t: Date.now(), el: snap(e.target), frame: window.location.href }), true);
      document.addEventListener('change', (e) => window.__spy_log.push({ type: 'change', t: Date.now(), el: snap(e.target), frame: window.location.href }), true);
    }).catch(() => {});
  }

  // Poll em todos os frames
  const recording = { context: 'pasta-digital', navigations: [{ url: urlInicial }], interactions: [] };
  let lastActivity = Date.now();
  let hasInteracted = false;
  let done = false;

  const poll = setInterval(async () => {
    if (done) return;
    for (const frame of paginaPasta.frames()) {
      try {
        const events = await frame.evaluate(() => {
          const evs = window.__spy_log ?? [];
          window.__spy_log = [];
          return evs;
        });
        if (events.length > 0) {
          recording.interactions.push(...events);
          hasInteracted = true;
          lastActivity = Date.now();
          events.forEach((e) => {
            const el = e.el;
            const desc = `<${el.tag}${el.id ? ` id="${el.id}"` : ''}> "${(el.text ?? '').slice(0, 60)}"`;
            console.log(`[recorder] ${e.type} [${(e.frame || '').split('/').pop()}] → ${desc}`);
          });
        }
      } catch {}
    }
    if (hasInteracted && Date.now() - lastActivity >= INACTIVITY_MS) {
      clearInterval(poll);
      done = true;
      fs.writeFileSync(RECORD_FILE, JSON.stringify(recording, null, 2));
      console.log('\n[recorder] Gravação finalizada → data/recording.json');
      await browser.close();
    }
  }, 300);
}

// --- modo: fluxo-protocolar ---
// Abre o SIGAD na página inicial e grava as interações do usuário pelas etapas 1-4.
// Monitora também novas abas abertas (ex: ESAJ ao clicar no processo na etapa 4).
// Inatividade de 10s para encerrar.

async function modoFluxoProtocolar() {
  const { browser, context } = await abrirBrowser();
  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(SIGAD_INICIO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await aguardarAjax(page);

  const urlInicial = page.url();
  console.log(`[recorder] SIGAD início carregado: ${urlInicial}`);
  await injectSpy(page);

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    console.log(`[recorder][SIGAD] nav → ${frame.url()}`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await injectSpy(page);
  });

  // Monitora novas abas abertas (ESAJ ao clicar no processo na etapa 4)
  const paginasMonitoradas = new Set([page]);
  context.on('page', async (novaAba) => {
    paginasMonitoradas.add(novaAba);
    await novaAba.waitForLoadState('domcontentloaded').catch(() => {});
    console.log(`[recorder][ESAJ] nova aba: ${novaAba.url()}`);
    await injectSpy(novaAba);
    novaAba.on('framenavigated', async (frame) => {
      if (frame !== novaAba.mainFrame()) return;
      console.log(`[recorder][ESAJ] nav → ${frame.url()}`);
      await novaAba.waitForLoadState('domcontentloaded').catch(() => {});
      await injectSpy(novaAba);
    });
  });

  const recording = {
    context:      'fluxo-protocolar',
    navigations:  [{ t: Date.now(), url: urlInicial }],
    interactions: [],
    tableStructure: null,
  };

  const INATIVIDADE = 10000;
  let lastActivity  = Date.now();
  let hasInteracted = false;
  let done          = false;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  [recorder] PRONTO — FLUXO PROTOCOLAR (Etapas 1–4)          ║');
  console.log('║                                                                ║');
  console.log('║  Navegue: Fases → Documentos → Dados Básicos → Processo      ║');
  console.log('║  Ao clicar no Processo, o ESAJ abrirá e será gravado também. ║');
  console.log('║  Gravação encerra após 10s sem atividade.                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  await new Promise((resolve) => {
    const poll = setInterval(async () => {
      if (done) return;

      for (const pg of paginasMonitoradas) {
        try {
          const events = await pg.evaluate(() => {
            const evs = window.__spy_log ?? [];
            window.__spy_log = [];
            return evs;
          });

          if (events.length > 0) {
            recording.interactions.push(...events);
            hasInteracted = true;
            lastActivity  = Date.now();

            const origem = pg === page ? 'SIGAD' : 'ESAJ';
            events.forEach((e) => {
              const el   = e.el;
              const desc = `<${el.tag}${el.id ? ` id="${el.id}"` : ''}> "${(el.text ?? '').slice(0, 60)}"`;
              if (e.type === 'change')     console.log(`[recorder][${origem}] change → ${desc}  value="${el.value}"`);
              else if (e.type === 'input') console.log(`[recorder][${origem}] input  → ${desc}  value="${el.value}"`);
              else                         console.log(`[recorder][${origem}] click  → ${desc}`);
            });
          }
        } catch {}
      }

      if (hasInteracted && Date.now() - lastActivity >= INATIVIDADE) {
        clearInterval(poll);
        done = true;
        recording.tableStructure = await captureTableStructure(page).catch(() => null);
        fs.writeFileSync(RECORD_FILE, JSON.stringify(recording, null, 2));
        console.log('\n[recorder] Gravação finalizada.');
        console.log('[recorder] Arquivo salvo em: data/recording.json');
        await browser.close();
        resolve();
      }
    }, 300);
  });
}

// --- fluxo principal ---

async function main() {
  const modo = process.argv[2];
  if (modo === 'esaj-login')            await modoEsajLogin();
  else if (modo === 'guia-processo')    await modoGuiaProcesso();
  else if (modo === 'pasta-digital')    await modoPastaDigital();
  else if (modo === 'fluxo-protocolar') await modoFluxoProtocolar();
  else                                  await modoVisualizarAutos();
}

main().catch((err) => {
  console.error('[recorder] Erro:', err.message);
  process.exit(1);
});
