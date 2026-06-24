const fs = require('fs');
const path = require('path');
const { normalizarData, abrirBrowser, garantirSessao } = require('./crawler');
const {
  inicializarFeriados,
  calcularDataPrevistaPrazo,
  parseDateBR,
  formatDateBR,
} = require('./data-prazo');

const RESULT_FILE = path.resolve(__dirname, '../../data/resultado-pericia.json');

// --- skill de classificação (comentada para economizar uso do Claude) ---

const { spawnSync, spawn } = require('child_process');

const PERICIA_SKILL_CONTENT = fs.readFileSync(
  path.resolve(__dirname, '../../.claudeskills/skill-tipo-pericia/skill-tipo-pericia.md'),
  'utf-8'
);
const TIPOS_PERICIA_CONTENT = fs.readFileSync(
  path.resolve(__dirname, '../../.claudeskills/skill-tipo-pericia/tipo_pericia.md'),
  'utf-8'
);
const HONORARIOS_SKILL_CONTENT = fs.readFileSync(
  path.resolve(__dirname, '../../.claudeskills/skill-proposta-honorarios/skill-proposta-honorarios.md'),
  'utf-8'
);
const HONORARIOS_MATRIZ_CONTENT = fs.readFileSync(
  path.resolve(__dirname, '../../.claudeskills/skill-proposta-honorarios/matriz_honorarios.md'),
  'utf-8'
);

const USAR_SKILLS = true;

function chamarClaude(prompt) {
  const result = spawnSync('claude', [], {
    input: prompt,
    encoding: 'utf-8',
    timeout: 120000,
    shell: true,
    cwd: path.resolve(__dirname, '../../'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Claude CLI falhou');
  return result.stdout.trim();
}

function chamarClaudeAsync(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [], {
      shell: true,
      cwd: path.resolve(__dirname, '../../'),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `Claude CLI falhou (exit ${code})`));
      else resolve(stdout.trim());
    });
    proc.on('error', reject);
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

async function executarSkillsAsync(servico, resumo) {
  console.log(`[skill] Serviço ${servico}: chamando skill-tipo-pericia...`);
  const saidaTipo = await chamarClaudeAsync(
    `${PERICIA_SKILL_CONTENT}\n\n---\n\n${TIPOS_PERICIA_CONTENT}\n\nInput:\n${JSON.stringify({ id: servico, resumoProcesso: resumo })}`
  );
  console.log(`[skill] Serviço ${servico}: skill-tipo-pericia retornou.`);
  const resultTipo = parsearResultado(saidaTipo, servico);
  console.log(`[skill] Serviço ${servico}: tipoPericia="${resultTipo.tipoPericia}" | chamando skill-proposta-honorarios...`);

  const saidaHon = await chamarClaudeAsync(
    `${HONORARIOS_SKILL_CONTENT}\n\n---\n\n${HONORARIOS_MATRIZ_CONTENT}\n\nInput:\n${JSON.stringify({ id: servico, tipoPericia: resultTipo.tipoPericia, resumoProcesso: resumo })}`
  );
  console.log(`[skill] Serviço ${servico}: skill-proposta-honorarios retornou.`);
  const resultHon = parsearHonorarios(saidaHon);

  return {
    servico,
    tipoPericia:            resultTipo.tipoPericia,
    justificativa:          resultTipo.justificativa,
    natureza_tabela:        resultHon.natureza_tabela,
    unidade_medida:         resultHon.unidade_medida,
    quantidade_extraida:    resultHon.quantidade_extraida,
    faixa_enquadramento:    resultHon.faixa_enquadramento,
    valor_minimo_proposto:  resultHon.valor_minimo_proposto,
    valor_maximo_proposto:  resultHon.valor_maximo_proposto,
    justificativa_extracao: resultHon.justificativa_extracao,
  };
}

function classificarComSkill(servico, resumoProcesso) {
  const userInput = JSON.stringify({ id: servico, resumoProcesso });
  const prompt = `${PERICIA_SKILL_CONTENT}\n\n---\n\n${TIPOS_PERICIA_CONTENT}\n\nInput:\n${userInput}`;
  return chamarClaude(prompt);
}

function proporHonorarios(servico, resumoProcesso, tipoPericia) {
  const userInput = JSON.stringify({ id: servico, tipoPericia, resumoProcesso });
  const prompt = `${HONORARIOS_SKILL_CONTENT}\n\n---\n\n${HONORARIOS_MATRIZ_CONTENT}\n\nInput:\n${userInput}`;
  return chamarClaude(prompt);
}

// --- integração Gemini ---

const PYTHON_BIN   = path.resolve(__dirname, '../../.venv/Scripts/python.exe');
const RESUMO_PY    = path.resolve(__dirname, '../local/resumo_gemini.py');
const PROCESSO_PDF = path.resolve(__dirname, '../../data/processo-temp.pdf');

function gerarResumoGemini(pdfPath) {
  const result = spawnSync(PYTHON_BIN, [RESUMO_PY, pdfPath], {
    encoding: 'utf-8',
    timeout: 600000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (result.error) {
    console.error(`[gemini] Erro ao executar script: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    console.error(`[gemini] Script falhou (exit ${result.status}): ${(result.stderr || '').trim()}`);
    return null;
  }
  return result.stdout.trim() || null;
}

function mdParaHtmlQuill(md) {
  // Paleta alinhada ao chat.html: laranja para títulos/negrito, fundo âmbar para palavras-chave
  const S_STRONG = 'color:#ee7d07;font-weight:600;';
  const S_H1     = 'color:#ee7d07;font-weight:700;font-size:1.25em;display:block;margin-top:14px;';
  const S_H2     = 'color:#ee7d07;font-weight:700;font-size:1.1em;display:block;margin-top:10px;';
  const S_H3     = 'color:#ee7d07;font-weight:600;font-size:1em;display:block;margin-top:8px;';
  const S_KW     = 'color:#ee7d07;font-weight:600;background:#fff3e0;padding:1px 4px;border-radius:3px;';

  // Termos jurídicos relevantes ao domínio de perícias
  const PALAVRAS_CHAVE = [
    'petição inicial','sentença','despacho','laudo pericial','laudo','perícia médica',
    'perícia','intimação','citação','recurso','agravo','apelação','contestação',
    'acórdão','honorários periciais','honorários','quesitos','assistente técnico',
    'incapacidade','nexo causal','dano moral','indenização',
  ];

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return s
      .replace(/\*\*([^*\n]+)\*\*/g, `<strong style="${S_STRONG}">$1</strong>`)
      .replace(/\*([^*\n]+)\*/g,     '<em>$1</em>')
      .replace(/_([^_\n]+)_/g,       '<em>$1</em>');
  }

  function destacar(s) {
    // Aplica destaque nas palavras-chave (do mais longo para o mais curto, evita sobreposição)
    const sorted = [...PALAVRAS_CHAVE].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      const re = new RegExp(`(?<![a-zA-ZÀ-ú])(${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![a-zA-ZÀ-ú])`, 'gi');
      s = s.replace(re, `<strong style="${S_KW}">$1</strong>`);
    }
    return s;
  }

  function processarLinha(s) {
    return inline(escHtml(s));
  }

  const html = [];
  let inUl = false;
  let inOl = false;

  function fecharListas() {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  }

  for (const linha of md.split('\n')) {
    if (/^### (.+)/.test(linha)) {
      fecharListas();
      html.push(`<h3 style="${S_H3}">${processarLinha(linha.slice(4))}</h3>`);
    } else if (/^## (.+)/.test(linha)) {
      fecharListas();
      html.push(`<h2 style="${S_H2}">${processarLinha(linha.slice(3))}</h2>`);
    } else if (/^# (.+)/.test(linha)) {
      fecharListas();
      html.push(`<h1 style="${S_H1}">${processarLinha(linha.slice(2))}</h1>`);
    } else if (/^---+$/.test(linha.trim())) {
      fecharListas();
      html.push('<hr>');
    } else if (/^[-*] (.+)/.test(linha)) {
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${processarLinha(linha.replace(/^[-*] /, ''))}</li>`);
    } else if (/^\d+\. (.+)/.test(linha)) {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${processarLinha(linha.replace(/^\d+\. /, ''))}</li>`);
    } else if (linha.trim() === '') {
      fecharListas();
      html.push('<p><br></p>');
    } else {
      fecharListas();
      html.push(`<p>${processarLinha(linha)}</p>`);
    }
  }
  fecharListas();
  return html.join('');
}

function parsearHonorarios(saida) {
  const jsonMatch = saida.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }
  console.log(`[api-site][debug] Saída bruta de honorários:\n${saida.slice(0, 600)}`);
  return {
    natureza_tabela:       'DESCONHECIDO',
    unidade_medida:        '',
    quantidade_extraida:   '',
    faixa_enquadramento:   '',
    valor_minimo_proposto: '',
    valor_maximo_proposto: '',
    justificativa_extracao: '',
  };
}

function parsearResultado(saida, servico) {
  const jsonMatch = saida.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const { resumoProcesso: _r, id: _i, ...campos } = JSON.parse(jsonMatch[1].trim());
      return { servico, ...campos };
    } catch {}
  }
  const tipoMatch = saida.match(/Perícia Atribuída:\s*(.+)/);
  const justMatch  = saida.match(/Justificativa:\s*(.+)/);
  if (!tipoMatch) {
    console.log(`[api-site][debug] Saída bruta da skill para ${servico}:\n${saida.slice(0, 600)}`);
  }
  return {
    servico,
    tipoPericia:   tipoMatch?.[1]?.trim() ?? 'DESCONHECIDO',
    justificativa: justMatch?.[1]?.trim() ?? '',
  };
}


// --- mock / notas ---

function carregarMockResultado(servico) {
  if (!fs.existsSync(RESULT_FILE)) return null;
  const dados = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
  const item = dados.find((r) => r.servico === servico);
  if (!item) return null;

  // Normaliza estrutura aninhada (propostaHonorarios objeto) → plana
  const hon = (item.propostaHonorarios && typeof item.propostaHonorarios === 'object')
    ? item.propostaHonorarios
    : {};
  return {
    tipoPericia:            item.tipoPericia            ?? 'DESCONHECIDO',
    justificativa:          item.justificativa           ?? '',
    natureza_tabela:        hon.natureza_tabela          ?? '',
    unidade_medida:         hon.unidade_medida           ?? '',
    quantidade_extraida:    hon.quantidade_extraida      ?? '',
    faixa_enquadramento:    hon.faixa_enquadramento      ?? '',
    valor_minimo_proposto:  hon.valor_minimo_proposto    ?? '',
    valor_maximo_proposto:  hon.valor_maximo_proposto    ?? '',
    justificativa_extracao: item.justificativaHonorarios ?? hon.justificativa_extracao ?? '',
  };
}

function montarLinhasClassificacao(r) {
  // label → laranja+negrito | value → cor padrão
  return [
    { label: 'Classificação da Perícia:',          value: '' },
    { label: '- Tipo de perícia: ',                 value: r.tipoPericia },
    { label: '    - Justificativa: ',               value: r.justificativa },
    { label: '- Proposta de honorários:',           value: '' },
    { label: '        - Natureza: ',                value: r.natureza_tabela },
    { label: '        - Unidade: ',                 value: r.unidade_medida },
    { label: '        - Quantidade Extraída: ',     value: String(r.quantidade_extraida) },
    { label: '        - Faixa de enquadramento: ',  value: r.faixa_enquadramento },
    { label: '        - Valor mínimo proposto: ',   value: r.valor_minimo_proposto },
    { label: '        - Valor máximo proposto: ',   value: r.valor_maximo_proposto },
    { label: '        - Justificativa: ',           value: r.justificativa_extracao },
  ];
}

function montarLinhasPartes(grupos) {
  if (!grupos || grupos.length === 0) return [];

  const linhas = [{ label: 'Partes envolvidas:', value: '' }];

  for (const grupo of grupos) {
    linhas.push({ label: 'Participação: ', value: (grupo.participacao || '(não informado)').trim() });

    for (const membro of (grupo.membros || [])) {
      const nome = (membro.nome || '').trim();
      const doc  = (membro.documento || '').trim();
      const nomeDisplay = nome && doc ? `${nome} (${doc})`
                        : nome       ? nome
                        : doc        ? `(${doc})`
                        :              '(não identificado)';
      linhas.push({ label: '            - Nome: ', value: nomeDisplay });
    }

    const advs = Array.isArray(grupo.advogados) ? grupo.advogados : [];
    if (advs.length > 0) {
      linhas.push({ label: '            - Advogado da Participação: ', value: '' });
      for (const adv of advs) {
        const advNome = (adv.nome || '').trim();
        const advDoc  = (adv.documento || '').trim();
        const advDisplay = advNome && advDoc ? `${advNome} (OAB/${advDoc})`
                         : advNome           ? advNome
                         : advDoc            ? `(OAB/${advDoc})`
                         :                     '(não identificado)';
        linhas.push({ label: '                    - ', value: advDisplay });
      }
    }
  }

  return linhas;
}

function montarHtmlLinhas(linhas) {
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return [
    '<p><br></p>',
    '<p><br></p>',
    ...linhas.map(({ label, value }) => {
      const labelEsc  = escHtml(label).replace(/ /g, '&nbsp;');
      const labelHTML = label
        ? `<strong><span style="color: rgb(238, 125, 7);">${labelEsc}</span></strong>`
        : '';
      const valueHTML = value ? escHtml(value) : '';
      return `<p>${labelHTML || '<br>'}${valueHTML}</p>`;
    }),
  ].join('');
}

async function escreverClassificacaoEmNotas(page, servico, resultado) {
  await fecharDialog(page);

  const link = page
    .locator('#formServico\\:tabela_data tr')
    .filter({ has: page.locator(`td a span:has-text("${servico}")`) })
    .first()
    .locator('td')
    .first()
    .locator('a');

  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click({ force: true });

  const dialog = page.locator('[id="formDlgVerServico"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await aguardarAjax(page);

  const tabNotas = dialog.locator('a:has-text("Notas")').first();
  await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
  await tabNotas.click();
  await page.waitForTimeout(600);
  await aguardarAjax(page);

  await dialog.locator('div.ql-editor').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);

  const partes = carregarPartes();
  const linhas = [
    ...montarLinhasClassificacao(resultado),
    { label: '', value: '' },
    ...montarLinhasPartes(partes),
  ];

  // Guarda HTML original e insere bloco formatado via innerHTML
  await page.evaluate(({ ls }) => {
    const editor = document.querySelector('#formDlgVerServico .ql-editor');
    if (!editor) throw new Error('Editor .ql-editor não encontrado no dialog');

    window.__notasOriginal = editor.innerHTML;

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    const novoHTML = [
      '<p><br></p>',
      '<p><br></p>',
      ...ls.map(({ label, value }) => {
        const labelEsc  = escHtml(label).replace(/ /g, '&nbsp;');
        const labelHTML = label
          ? `<strong><span style="color: rgb(238, 125, 7);">${labelEsc}</span></strong>`
          : '';
        const valueHTML = value ? escHtml(value) : '';
        return `<p>${labelHTML || '<br>'}${valueHTML}</p>`;
      }),
    ].join('');

    editor.innerHTML = window.__notasOriginal + novoHTML;
    editor.scrollTop = editor.scrollHeight;
  }, { ls: linhas });

  console.log(`[api-site] Serviço ${servico}: classificação escrita em Notas.`);

  // Aguarda 5s para verificação visual
  await page.waitForTimeout(7000);

  // Restaura HTML original — remove APENAS o bloco inserido
  await page.evaluate(() => {
    const editor = document.querySelector('#formDlgVerServico .ql-editor');
    if (editor && window.__notasOriginal !== undefined) {
      editor.innerHTML = window.__notasOriginal;
      delete window.__notasOriginal;
    }
  });

  console.log(`[api-site] Serviço ${servico}: resultado da classificação removido de Notas.`);

  // Aguarda 2s para confirmação visual da remoção
  await page.waitForTimeout(2000);

  await fecharDialog(page);
  await aguardarAjax(page);
}

async function escreverResumoEmNotas(page, servico, htmlResumo) {
  await fecharDialog(page);

  const link = page
    .locator('#formServico\\:tabela_data tr')
    .filter({ has: page.locator(`td a span:has-text("${servico}")`) })
    .first()
    .locator('td')
    .first()
    .locator('a');

  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click({ force: true });

  const dialog = page.locator('[id="formDlgVerServico"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await aguardarAjax(page);

  const tabNotas = dialog.locator('a:has-text("Notas")').first();
  await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
  await tabNotas.click();
  await page.waitForTimeout(600);
  await aguardarAjax(page);

  await dialog.locator('div.ql-editor').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);

  // Insere o resumo Gemini APÓS o conteúdo existente das Notas
  await page.evaluate(({ html }) => {
    const editor = document.querySelector('#formDlgVerServico .ql-editor');
    if (!editor) throw new Error('Editor .ql-editor não encontrado no dialog');
    window.__notasOriginalResumo = editor.innerHTML;
    editor.innerHTML = window.__notasOriginalResumo + '<p><br></p><p><br></p>' + html;
    editor.scrollTop = editor.scrollHeight;
  }, { html: htmlResumo });

  console.log(`[api-site] Serviço ${servico}: resumo Gemini escrito em Notas.`);

  // [SIMULAÇÃO] Aguarda 10s para verificação visual e restaura
  await page.waitForTimeout(10000);

  await page.evaluate(() => {
    const editor = document.querySelector('#formDlgVerServico .ql-editor');
    if (editor && window.__notasOriginalResumo !== undefined) {
      editor.innerHTML = window.__notasOriginalResumo;
      delete window.__notasOriginalResumo;
    }
  });

  console.log(`[api-site] Serviço ${servico}: resumo Gemini removido de Notas. [SIMULAÇÃO]`);
  await page.waitForTimeout(2000);

  await fecharDialog(page);
  await aguardarAjax(page);
}

// --- sessão única de dialog por serviço ---

async function abrirNotasServico(page, servico) {
  await fecharDialog(page);
  const link = page
    .locator('#formServico\\:tabela_data tr')
    .filter({ has: page.locator(`td a span:has-text("${servico}")`) })
    .first().locator('td').first().locator('a');
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click({ force: true });
  const dialog = page.locator('[id="formDlgVerServico"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await aguardarAjax(page);
  const tabNotas = dialog.locator('a:has-text("Notas")').first();
  await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
  await tabNotas.click();
  await page.waitForTimeout(600);
  await aguardarAjax(page);
  await dialog.locator('div.ql-editor').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);
  return dialog;
}

async function injetarNasNotas(page, servico, html, tag, qlSelector = '[id="formServico"] div.ql-editor') {
  await page.evaluate(({ h, sel }) => {
    const editor = document.querySelector(sel);
    if (!editor) throw new Error('Editor ' + sel + ' não encontrado');
    editor.innerHTML = editor.innerHTML + h;
    editor.scrollTop = editor.scrollHeight;
  }, { h: html, sel: qlSelector });
  console.log(`[api-site] Serviço ${servico}: ${tag} injetado nas Notas.`);
}

async function abrirNotasDetalhe(page) {
  const tabNotas = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Notas$/ }).first();
  await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
  await tabNotas.click();
  await page.waitForTimeout(300);
  await aguardarAjax(page);
  const qlEditor = page.locator('[id="formServico"] div.ql-editor');
  await qlEditor.waitFor({ state: 'visible', timeout: 15000 });
  // Aguarda o conteúdo carregar (timeout curto — Notas podem estar vazias)
  await page.waitForFunction(() => {
    const el = document.querySelector('[id="formServico"] div.ql-editor');
    return el && el.innerText.trim().length > 0;
  }, { timeout: 2000 }).catch(() => {});
  return qlEditor;
}

const FILTRO_TEOR = 'Nomeação';

// --- helpers de automação ---

async function aguardarAjax(page) {
  await page.waitForFunction(
    () => typeof window.PrimeFaces === 'undefined' || window.PrimeFaces.ajax.Queue.isEmpty(),
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function extrairLinhasDaPagina(page) {
  const rows = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#formServico\\:tabela_head th')];
    const teorIdx = ths.findIndex((th) => th.id === 'formServico:tabela:j_idt337' || th.id === 'formServico:tabela:j_idt373');
    const dispIdx = ths.findIndex((th) => th.id === 'formServico:tabela:j_idt321' || th.id === 'formServico:tabela:j_idt357');


    function textoDaCelula(td) {
      if (!td) return '';
      const clone = td.cloneNode(true);
      clone.querySelectorAll('.ui-column-title').forEach((el) => el.remove());
      return clone.textContent.trim();
    }

    const procIdx = ths.findIndex((th) => th.id === 'formServico:tabela:j_idt331' || th.id === 'formServico:tabela:j_idt367');

    return [...document.querySelectorAll('#formServico\\:tabela_data tr')]
      .map((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const link = cells[0]?.querySelector('a');
        if (!link) return null;
        const servico = link.querySelector('span')?.textContent.trim() ?? '';
        const teor = teorIdx >= 0 ? textoDaCelula(cells[teorIdx]) : '';
        const disponibilizacao = dispIdx >= 0 ? textoDaCelula(cells[dispIdx]) : '';
        // Extrai n° do processo do href ESAJ: ?dadosConsulta.valorConsultaNuUnificado=XXXX
        const esajHref = procIdx >= 0 ? (cells[procIdx]?.querySelector('a')?.href ?? '') : '';
        const processoMatch = esajHref.match(/dadosConsulta\.valorConsultaNuUnificado=([^&]+)/);
        const processo = processoMatch ? decodeURIComponent(processoMatch[1]) : '';
        return servico ? { servico, teor, disponibilizacao, processo } : null;
      })
      .filter(Boolean);
  });
  return rows.map((r) => ({ ...r, disponibilizacao: normalizarData(r.disponibilizacao) }));
}

async function fecharDialog(page) {
  const dialog = page.locator('[id="formDlgVerServico"]');
  if (!(await dialog.isVisible().catch(() => false))) return;

  await page.evaluate(() => { try { PF('DlgVerServico').hide(); } catch {} }).catch(() => {});
  const fechouComPF = await dialog.waitFor({ state: 'hidden', timeout: 4000 }).then(() => true).catch(() => false);
  if (fechouComPF) return;

  await dialog.locator('.ui-dialog-titlebar-close').click({ force: true, timeout: 3000 }).catch(() => {});
  const fechouComBtn = await dialog.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
  if (fechouComBtn) return;

  await page.evaluate(() => {
    const el = document.getElementById('formDlgVerServico');
    if (el) el.style.display = 'none';
  }).catch(() => {});
}

async function lerNotasDoServico(page, servico) {
  await fecharDialog(page);

  const link = page
    .locator('#formServico\\:tabela_data tr')
    .filter({ has: page.locator(`td a span:has-text("${servico}")`) })
    .first()
    .locator('td')
    .first()
    .locator('a');

  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click({ force: true });

  const dialog = page.locator('[id="formDlgVerServico"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await aguardarAjax(page);

  const tabNotas = dialog.locator('a:has-text("Notas")').first();
  await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
  await tabNotas.click();
  await page.waitForTimeout(600);
  await aguardarAjax(page);

  const qlEditor = dialog.locator('div.ql-editor');
  await qlEditor.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);
  const resumo = await qlEditor.innerText();

  await fecharDialog(page);
  await aguardarAjax(page);

  return resumo.trim();
}

// --- criação do evento ---

async function criarEventoEntregaProposta(page, teor, data) {
  // Tipo Evento = ENTREGA PROPOSTA
  await page.locator('[id="formDlgEventoServico:inputTipoEvento_label"]').click();
  const panel = page.locator('[id="formDlgEventoServico:inputTipoEvento_panel"]');
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  await panel.locator('li[data-label="ENTREGA PROPOSTA"], li:has-text("ENTREGA PROPOSTA")').first().click();
  await aguardarAjax(page);

  // Data Prevista
  const inputPrevisto = page.locator('[id="formDlgEventoServico:inputDataPrevisto_input"]');
  await inputPrevisto.fill(data);
  await inputPrevisto.press('Tab');
  await page.waitForTimeout(300);

  // Data Prazo (igual à Data Prevista)
  const inputPrazo = page.locator('[id="formDlgEventoServico:inputDataPrazo_input"]');
  await inputPrazo.fill(data);
  await inputPrazo.press('Tab');
  await page.waitForTimeout(300);

  // Observação = teor da intimação
  await page.locator('[id="formDlgEventoServico:inputObs"]').fill(teor);

  await page.locator('[id="formDlgEventoServico:j_idt760"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[id="formDlgEventoServico:j_idt760"]').click();
  await aguardarAjax(page);
  await page.waitForTimeout(500);
}

const DETAIL_BASE  = 'https://sistemas.vcpericia.com.br/sigad/usuario/servico/index.xhtml?numero=';
const TARGET_URL   = 'https://sistemas.vcpericia.com.br/sigad/usuario/atos/index.xhtml';
const PESSOAS_URL  = 'https://sistemas.vcpericia.com.br/sigad/usuario/pessoa/index.xhtml';
const PENDING_FILE = path.resolve(__dirname, '../../data/pending.json');
const PARTES_FILE  = path.resolve(__dirname, '../../data/partes-temporarias.json');
const RESUMO_FILE  = path.resolve(__dirname, '../../data/resumo-gemini.md');

// --- helpers de progresso/recuperação ---

function progressoInicial(servicoId) {
  return {
    servico: servicoId,
    gemini: false,
    skills: false,
    skills_resultado: null,
    partes: { concluido: false, grupo: 0, membro: 0, fase: 'parte', adv: 0 },
    evento: false,
    notas: { resumo: false, classificacao: false, salvo: false },
  };
}

function carregarPendingDados() {
  if (!fs.existsSync(PENDING_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
    if (Array.isArray(raw)) {
      // formato antigo — migra para novo
      return { servicos: raw, progresso: raw.length > 0 ? progressoInicial(raw[0].servico) : null };
    }
    return raw;
  } catch { return null; }
}

function salvarPendingDados(servicos, progresso) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify({ servicos, progresso }, null, 2));
}

function limparArquivosServico() {
  for (const f of [PARTES_FILE, PROCESSO_PDF, RESUMO_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

const ESAJ_CPOPG_URL = 'https://esaj.tjms.jus.br/cpopg5/';
const ESAJ_LOGIN_URL = 'https://esaj.tjms.jus.br/sajcas/login/aba-certificado';

// --- extração de partes de Notas ---
//
// Formatos recorrentes nas Notas (sem padrão fixo — variantes além destas existem):
//
//  Formato A — subníveis por participação:
//    - Requerente:
//        - Nome: FULANO
//        - CPF/CNPJ: 123.456.789-00
//        - Advogado: DR. X (OAB/SP nº 12345)
//
//  Formato B — bloco de advogados separado (pertence à participação imediatamente acima):
//    - Requerente:
//        - Nome: FULANO
//        - CPF/CNPJ: 123.456.789-00
//    - Advogados*:
//        - DR. X (OAB/SP nº 12345)
//        - DR. Y (OAB/SP nº 67890)
//    - Requerido:
//        - Nome: BELTRANO
//        - CPF/CNPJ: 12.345.678/0001-99
//        - Advogado: DR. Z (OAB/SP nº 11111), Advogado: DR. W (OAB/SP nº 22222)
//
//  Formato C — documento inline no campo Nome:
//    - Requerente:
//        - Nome: FULANO (123.456.789-00)
//        - Advogado: DR. X (OAB/SP nº 12345)
//
// Participação: o label pode aparecer no plural ou em variante feminina (Réus → Réu,
// Autoras → Autora). Ver normalizarParticipacao(). Documento pode ser CPF, CNPJ ou OAB.
// Campos reservados (não iniciam bloco de participação): Nome, CPF, CNPJ, OAB, Advogado(s).
// Schema de saída: [{ participacao, membros: [{nome, documento, tipo_doc}], advogados: [{nome, documento, tipo_doc}] }]

// Plurais, femininos e variantes ortográficas → forma canônica singular.
const PARTICIPACAO_NORM = new Map([
  // RÉU / RÉ
  ['RÉUS', 'RÉU'], ['REUS', 'RÉU'], ['REU', 'RÉU'],
  ['RÉS',  'RÉ'],  ['RES',  'RÉ'],  ['RE',  'RÉ'],
  // AUTOR / AUTORA
  ['AUTORES',           'AUTOR'],        ['AUTORAS',           'AUTORA'],
  // REQUERENTE / REQUERIDO
  ['REQUERENTES',       'REQUERENTE'],
  ['REQUERIDOS',        'REQUERIDO'],    ['REQUERIDAS',        'REQUERIDA'],
  // APELANTE / APELADO
  ['APELANTES',         'APELANTE'],
  ['APELADOS',          'APELADO'],      ['APELADAS',          'APELADA'],
  // RECLAMANTE / RECLAMADO
  ['RECLAMANTES',       'RECLAMANTE'],
  ['RECLAMADOS',        'RECLAMADO'],    ['RECLAMADAS',        'RECLAMADA'],
  // EMBARGANTE / EMBARGADO
  ['EMBARGANTES',       'EMBARGANTE'],
  ['EMBARGADOS',        'EMBARGADO'],    ['EMBARGADAS',        'EMBARGADA'],
  // IMPETRANTE / IMPETRADO
  ['IMPETRANTES',       'IMPETRANTE'],
  ['IMPETRADOS',        'IMPETRADO'],    ['IMPETRADAS',        'IMPETRADA'],
  // EXEQUENTE / EXECUTADO
  ['EXEQUENTES',        'EXEQUENTE'],
  ['EXECUTADOS',        'EXECUTADO'],    ['EXECUTADAS',        'EXECUTADA'],
  // INVENTARIANTE / INVENTARIADO
  ['INVENTARIANTES',    'INVENTARIANTE'],
  ['INVENTARIADOS',     'INVENTARIADO'], ['INVENTARIADAS',     'INVENTARIADA'],
  // HERDEIRO / HERDEIRA
  ['HERDEIROS',         'HERDEIRO'],     ['HERDEIRAS',         'HERDEIRA'],
  // INTERESSADO / INTERESSADA
  ['INTERESSADOS',      'INTERESSADO'],  ['INTERESSADAS',      'INTERESSADA'],
  // LITISCONSORTE
  ['LITISCONSORTES',          'LITISCONSORTE'],
  ['LITISCONSORTES ATIVOS',   'LITISCONSORTE ATIVO'],
  ['LITISCONSORTES PASSIVOS', 'LITISCONSORTE PASSIVO'],
  // TERCEIRO INTERESSADO
  ['TERCEIROS INTERESSADOS',  'TERCEIRO INTERESSADO'],
  // ADMINISTRADOR
  ['ADMINISTRADORES',   'ADMINISTRADOR'], ['ADMINISTRADORAS',  'ADMINISTRADORA'],
  // CURADOR
  ['CURADORES',         'CURADOR'],       ['CURADORAS',        'CURADORA'],
  // DEFENSOR
  ['DEFENSORES',        'DEFENSOR'],      ['DEFENSORAS',       'DEFENSORA'],
  // CONFLITANTE
  ['CONFLITANTES',      'CONFLITANTE'],
  // NOTIFICADO / NOTIFICANTE
  ['NOTIFICADOS',       'NOTIFICADO'],    ['NOTIFICADAS',      'NOTIFICADA'],
  ['NOTIFICANTES',      'NOTIFICANTE'],
  // DENUNCIADO
  ['DENUNCIADOS',       'DENUNCIADO'],    ['DENUNCIADAS',      'DENUNCIADA'],
  // RECONVINTE / RECONVINDA
  ['RECONVINTES',       'RECONVINTE'],    ['RECONVINDAS',      'RECONVINDA'],
  // ALIMENTADO / ALIMENTANTE (abrev. SIGAD: ALIMTDO / ALIMTTE)
  ['ALIMENTADOS',       'ALIMENTADO'],    ['ALIMENTADAS',      'ALIMENTADA'],
  ['ALIMENTANTES',      'ALIMENTANTE'],
  // SINDICO (sem acento no SIGAD)
  ['SÍNDICOS',          'SINDICO'],       ['SÍNDICAS',         'SINDICO'],
  ['SINDICOS',          'SINDICO'],       ['SINDICAS',         'SINDICO'],
  // CESSIONÁRIO
  ['CESSIONÁRIOS',      'CESSIONÁRIO'],   ['CESSIONÁRIAS',     'CESSIONÁRIA'],
  // PROCURADOR
  ['PROCURADORES',      'PROCURADOR'],    ['PROCURADORAS',     'PROCURADORA'],
  // ADVOGADO
  ['ADVOGADOS',         'ADVOGADO'],      ['ADVOGADAS',        'ADVOGADA'],
  // PARTE AUTORA / PARTE RÉ
  ['PARTES AUTORAS',    'PARTE AUTORA'],
  ['PARTES RÉS',        'PARTE RÉ'],      ['PARTES RES',       'PARTE RÉ'],
]);

function normalizarParticipacao(raw) {
  const upper = raw.trim().toUpperCase();
  if (PARTICIPACAO_NORM.has(upper)) return PARTICIPACAO_NORM.get(upper);
  // Fallback: remove plural 'es' ou 's' e tenta novamente
  if (upper.endsWith('ES') && upper.length > 4) {
    const sem = upper.slice(0, -2);
    if (PARTICIPACAO_NORM.has(sem)) return PARTICIPACAO_NORM.get(sem);
  }
  if (upper.endsWith('S') && upper.length > 3) {
    const sem = upper.slice(0, -1);
    if (PARTICIPACAO_NORM.has(sem)) return PARTICIPACAO_NORM.get(sem);
  }
  return upper;
}

// Sinônimos e variantes → opção exata do dropdown SIGAD.
// Aplicado sobre o resultado de normalizarParticipacao() antes de buscar no dropdown.
const PARTICIPACAO_SIGAD = new Map([
  // --- AUTOR: partes ativas e seus sinônimos processuais ---
  ['AUTORA',               'AUTOR'],
  ['PARTE AUTORA',         'AUTOR'],
  ['REQUERENTE',           'AUTOR'],
  ['APELANTE',             'AUTOR'],
  ['RECLAMANTE',           'AUTOR'],
  ['EMBARGANTE',           'AUTOR'],
  ['IMPETRANTE',           'AUTOR'],
  ['EXEQUENTE',            'AUTOR'],
  ['LITISCONSORTE ATIVO',  'AUTOR'],
  ['LITISCONSORTE ATIVA',  'AUTOR'],
  // --- RÉU: partes passivas e seus sinônimos processuais ---
  ['RÉ',                   'RÉU'],
  ['PARTE RÉ',             'RÉU'],
  ['REQUERIDO',            'RÉU'],
  ['REQUERIDA',            'RÉU'],
  ['APELADO',              'RÉU'],
  ['APELADA',              'RÉU'],
  ['RECLAMADO',            'RÉU'],
  ['RECLAMADA',            'RÉU'],
  ['EMBARGADO',            'RÉU'],
  ['EMBARGADA',            'RÉU'],
  ['IMPETRADO',            'RÉU'],
  ['IMPETRADA',            'RÉU'],
  ['EXECUTADO',            'RÉU'],
  ['EXECUTADA',            'RÉU'],
  ['LITISCONSORTE PASSIVO','RÉU'],
  ['LITISCONSORTE PASSIVA','RÉU'],
  // --- Femininos de termos com opção própria no SIGAD ---
  ['HERDEIRA',             'HERDEIRO'],
  ['ADMINISTRADORA',       'ADMINISTRADOR'],
  ['CURADORA',             'CURADOR'],
  ['DEFENSORA',            'DEFENSOR'],
  ['INVENTARIADA',         'INVENTARIADO'],
  ['NOTIFICADA',           'NOTIFICADO'],
  ['DENUNCIADA',           'DENUNCIADO'],
  ['CESSIONÁRIA',          'CESSIONÁRIO'],
  // --- TERCEIRO INTERESSADO: variantes e genéricos ---
  ['TERCEIRA INTERESSADA', 'TERCEIRO INTERESSADO'],
  ['INTERESSADO',          'TERCEIRO INTERESSADO'],
  ['INTERESSADA',          'TERCEIRO INTERESSADO'],
  // --- Abreviações SIGAD ← formas por extenso ---
  ['ALIMENTADO',           'ALIMTDO'],
  ['ALIMENTADA',           'ALIMTDO'],
  ['ALIMENTANTE',          'ALIMTTE'],
  // --- Variantes ortográficas ---
  ['SÍNDICO',              'SINDICO'],
  ['SÍNDICA',              'SINDICO'],
  ['SINDICA',              'SINDICO'],
]);

function sigadParticipacao(participacao) {
  return PARTICIPACAO_SIGAD.get(participacao) ?? participacao;
}

function parsearPartesDeNotas(texto) {
  const CPF_RE  = /\d{3}\.\d{3}\.\d{3}-\d{2}/;
  const CNPJ_RE = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
  // Após OAB/UF, pula qualquer coisa que não seja dígito (n°, nº, n., espaços, etc.)
  const OAB_RE  = /OAB[\/\s]+([A-Z]{2})[^0-9]*(\d[\d.]*)/i;
  // Remove trechos "(fls. xxx)" — não fazem parte do nome
  const FLS_RE  = /\(fls\.?\s*[\d\-v]+[^)]*\)/gi;

  // Normaliza para NFC e busca via indexOf+lowercase — o flag `i` do regex JS
  // não aplica case-folding confiável em ç/ã, mas indexOf com toLowerCase funciona.
  const textoNorm = texto.normalize('NFC');
  const textoLower = textoNorm.toLowerCase();
  const inicioIdx = textoLower.indexOf('relação de todas as partes envolvidas');
  if (inicioIdx === -1) return [];
  texto = textoNorm;

  // Campos reservados: nunca abrem bloco de participação
  const CAMPO_RESERVADO = /^(?:Nome|CPF\b[^:]*|CNPJ\b[^:]*|OAB\b[^:]*|Advogad[oa]s?[^:]*|Participa[çc][aã]o)\s*:/i;

  // Remove todos os bullets e espaços iniciais, independente da profundidade de indentação
  function stripLine(raw) {
    return raw.replace(/^[\s\-–•*]+/, '').trim();
  }

  function detectarDoc(str) {
    const cnpj = str.match(CNPJ_RE);
    if (cnpj) return { documento: cnpj[0], tipo_doc: 'cnpj' };
    const cpf = str.match(CPF_RE);
    if (cpf) return { documento: cpf[0], tipo_doc: 'cpf' };
    return null;
  }

  // Extrai advogado de qualquer linha que contenha OAB
  // Formatos suportados: "Nome (OAB/UF nº)", "Nome - OAB/UF n° 11.111", "Nome OAB/UF 11.111"
  function extrairAdv(str) {
    const semFls = str.replace(FLS_RE, '').trim();
    const oabMatch = semFls.match(OAB_RE);
    if (!oabMatch) return null;

    const pos = oabMatch.index;
    const nome = semFls.slice(0, pos)
      .replace(/^[\s\-–•*]+/, '')
      .replace(/^(?:Advogado|Procurador)\s*:\s*/i, '')
      .replace(/\s*\([^)]*\)/g, '')   // remove parênteses completos: "(texto)"
      .replace(/[\s\-–:,\(]+$/, '')   // remove separadores finais + "(" solto
      .trim();

    // Remove pontos do número OAB: "11.111" → "11111"
    const numOAB = oabMatch[2].replace(/\./g, '');
    return {
      nome:      nome.toUpperCase(),
      documento: `${oabMatch[1].toUpperCase()} ${numOAB}`,
      tipo_doc:  'oab',
    };
  }

  // Trunca nome no primeiro separador real (" - ", ","); preserva hífen sem espaços
  function truncarNome(str) {
    const s = str.replace(FLS_RE, '').replace(/\s*\([^)]*\)/g, '').trim();
    const pos = s.search(/\s+-\s+|,/);
    return (pos > 0 ? s.slice(0, pos) : s).trim();
  }

  // Schema agrupado: cada entrada representa uma participação com N membros e seus advogados
  const grupos = [];
  let atual = null;

  function fecharAtual() {
    if (atual && atual.membros.length > 0 &&
        !atual.participacao.startsWith('REPRESENTANTE') &&
        !atual.participacao.startsWith('PERITO'))
      grupos.push(atual);
    atual = null;
  }

  for (const rawLinha of texto.slice(inicioIdx).split('\n')) {
    const linha = stripLine(rawLinha);
    if (!linha) continue;

    // Qualquer linha com OAB é advogado da participação atual — independente de indentação ou modo.
    // Divide por " - " para capturar múltiplos advogados na mesma linha.
    if (OAB_RE.test(linha)) {
      if (atual) {
        for (const seg of linha.split(/\s+-\s+/)) {
          if (OAB_RE.test(seg)) {
            const adv = extrairAdv(seg);
            if (adv) atual.advogados.push(adv);
          }
        }
      }
      continue;
    }

    // Cabeçalho "Advogados/Advogadas/Advogados (...):" — linhas com OAB já capturadas acima
    // Cobre: "Advogados:", "Advogadas:", "Advogados da participação:", "Advogados (atuantes em diferentes fases):"
    if (/^Advogad[oa]s?[^:]*:/i.test(linha)) {
      continue;
    }

    // "Participação: <tipo>" — abre novo grupo; tipo pode vir na mesma linha
    if (/^Participa[çc][aã]o\s*:/i.test(linha)) {
      const tipoRaw = linha.replace(/^Participa[çc][aã]o\s*:\s*/i, '').replace(FLS_RE, '').trim();
      // Remove qualificadores: "Ré (Reconvinda)" → "Ré", "Requerido e Reconvindo" → "Requerido"
      const tipoLimpo = tipoRaw.replace(/\s*\([^)]*\)/g, '').replace(/\s+e\s+.*/i, '').replace(/\s*\*$/, '').trim();
      fecharAtual();
      atual = { participacao: tipoLimpo ? normalizarParticipacao(tipoLimpo) : 'PARTICIPAÇÃO', membros: [], advogados: [] };
      continue;
    }

    // "Nome: [valor]" — adiciona membro ao grupo atual; valor pode conter CPF/CNPJ inline
    if (/^Nome\s*:/i.test(linha)) {
      if (!atual) continue;
      const valor = linha.replace(/^Nome\s*:\s*/i, '').replace(FLS_RE, '').trim();
      const det = detectarDoc(valor);
      let nome, documento = '', tipo_doc = '';
      if (det) {
        documento = det.documento;
        tipo_doc  = det.tipo_doc;
        const idxDoc   = valor.indexOf(det.documento);
        // Recua até o "(" que engloba o documento para não deixar "(CPF: " no nome
        const idxParen = valor.lastIndexOf('(', idxDoc);
        const semDoc   = idxParen > 0 ? valor.slice(0, idxParen) : valor.slice(0, idxDoc);
        nome = truncarNome(semDoc);
      } else {
        nome = truncarNome(valor);
      }
      if (nome || documento) atual.membros.push({ nome: nome || '', documento, tipo_doc });
      continue;
    }

    // "CPF: / CNPJ: / CPF/CNPJ: / CPF ou CNPJ:" — atualiza o último membro adicionado
    if (/^(?:CPF|CNPJ)\b[^:]*:/i.test(linha)) {
      if (!atual) continue;
      const det = detectarDoc(linha);
      if (det) {
        const ultimo = atual.membros[atual.membros.length - 1];
        if (ultimo && !ultimo.documento) { ultimo.documento = det.documento; ultimo.tipo_doc = det.tipo_doc; }
      }
      continue;
    }

    // "Advogado: NOME (OAB)" inline
    if (/^(?:Advogado|Procurador)\s*:/i.test(linha)) {
      if (!atual) continue;
      const conteudo = linha.replace(/^(?:Advogado|Procurador)\s*:\s*/i, '');
      for (const seg of conteudo.split(/,\s*(?:Advogado|Procurador)\s*:\s*/i)) {
        if (OAB_RE.test(seg)) {
          const adv = extrairAdv(seg);
          if (adv) atual.advogados.push(adv);
        }
      }
      continue;
    }

    // Outros campos reservados
    if (CAMPO_RESERVADO.test(linha)) continue;

    // Nova participação: "LABEL: [resto]" — label ≥ 2 chars, não reservado
    const m = linha.match(/^([^:]{2,}?)\s*:\s*(.*)/);
    if (m) {
      fecharAtual();
      // Strips qualificadores parentéticos: "Autora (Requerente)" → "Autora"
      const rawLabel = m[1].replace(/\s*\([^)]*\)/g, '').replace(/\s*\*$/, '').trim();
      const participacao = normalizarParticipacao(rawLabel);
      const resto = m[2].replace(FLS_RE, '').trim();
      atual = { participacao, membros: [], advogados: [] };

      if (resto) {
        const det = detectarDoc(resto);
        let nome, documento = '', tipo_doc = '';
        if (det) {
          documento = det.documento;
          tipo_doc  = det.tipo_doc;
          nome = truncarNome(resto.slice(0, resto.indexOf(det.documento)));
        } else {
          nome = truncarNome(resto);
        }
        if (nome || documento) atual.membros.push({ nome: nome || '', documento, tipo_doc });
      }
      continue;
    }

    // Documento avulso sem label — atualiza o último membro adicionado
    if (atual) {
      const det = detectarDoc(linha);
      if (det) {
        const ultimo = atual.membros[atual.membros.length - 1];
        if (ultimo && !ultimo.documento) { ultimo.documento = det.documento; ultimo.tipo_doc = det.tipo_doc; }
      }
    }
  }

  fecharAtual();

  // Consolida grupos com a mesma participação (cobre saídas com blocos repetidos para o mesmo papel)
  const consolidados = [];
  const porParticipacao = new Map();
  for (const grupo of grupos) {
    const chave = grupo.participacao;
    if (porParticipacao.has(chave)) {
      const existente = porParticipacao.get(chave);
      existente.membros.push(...grupo.membros);
      // Merge de advogados sem duplicar (por nome, case-insensitive)
      for (const adv of grupo.advogados) {
        const k = (adv.nome || '').toUpperCase();
        if (!existente.advogados.some(a => (a.nome || '').toUpperCase() === k))
          existente.advogados.push(adv);
      }
    } else {
      porParticipacao.set(chave, grupo);
      consolidados.push(grupo);
    }
  }

  return consolidados;
}

async function gerarPartesDasNotas(page, servico) {
  const texto = await lerNotasDoServico(page, servico);

  const partes = parsearPartesDeNotas(texto);
  if (partes.length === 0) {
    console.warn(`[api-site] Serviço ${servico}: seção "Relação de Partes" não encontrada em Notas. partes-temporarias.json não gerado.`);
    return;
  }
  fs.writeFileSync(PARTES_FILE, JSON.stringify(partes, null, 2));
  const totalMembros = partes.reduce((acc, g) => acc + (g.membros || []).length, 0);
  console.log(`[api-site] Serviço ${servico}: ${partes.length} grupo(s), ${totalMembros} membro(s) extraído(s) → partes-temporarias.json.`);
}

// --- partes ---

function carregarPartes() {
  if (!fs.existsSync(PARTES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PARTES_FILE, 'utf-8')); }
  catch { return []; }
}

function limparPartes() {
  if (fs.existsSync(PARTES_FILE)) fs.unlinkSync(PARTES_FILE);
}

async function fecharNovaParte(page) {
  await page.evaluate(() => {
    try { PF('DlgServicoParte').hide(); return; } catch {}
    try { PF('dlgServicoParte').hide(); return; } catch {}
    const form = document.getElementById('formServicoParte');
    if (!form) return;
    let el = form;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('ui-dialog')) { el.style.display = 'none'; break; }
      el = el.parentElement;
    }
  }).catch(() => {});
  await page.waitForTimeout(400);
}

async function salvarNovaParte(page) {
  await page.locator('[id="formServicoParte:j_idt733"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[id="formServicoParte:j_idt733"]').click();
  await aguardarAjax(page);
  await page.waitForTimeout(500);
}

// Verifica se um nome já existe em qualquer linha da tabela de partes do serviço.
// Usa page.evaluate() para buscar o elemento pelo sufixo do ID, evitando dependência
// do número gerado dinamicamente pelo PrimeFaces (ex: j_idt472 pode mudar entre deploys).
async function nomeNaTabela(page, nome) {
  const resultado = await page.evaluate((n) => {
    const form = document.getElementById('formServico');
    if (!form) return { encontrado: false, debug: 'formServico não encontrado' };
    const tabela = form.querySelector('[id$="tabListaParte"]');
    if (!tabela) return { encontrado: false, debug: `tabListaParte não encontrada (id form: ${form.id})` };
    const linhas = [...tabela.querySelectorAll('tr')];
    const encontrado = linhas.some((tr) => tr.textContent.includes(n));
    return { encontrado, debug: `tabela id=${tabela.id}, ${linhas.length} linha(s)` };
  }, nome);
  if (!resultado.encontrado) {
    console.log(`[partes-check] "${nome}" — NÃO na tabela. ${resultado.debug}`);
  } else {
    console.log(`[partes-check] "${nome}" — JÁ na tabela. ${resultado.debug}`);
  }
  return resultado.encontrado;
}

async function processarUmAdvogado(page, adv, participacaoSigad, numeroURL, retentar = true, advGlobal = null) {
  const oabFmt = adv.documento
    ? `OAB/${adv.documento.replace(/^(\S+)\s+/, '$1 n° ')}`
    : '(OAB não encontrada)';

  const chaveAdv = (adv.nome || '').trim().toUpperCase();

  // 1ª linha de defesa: Set em memória (mesmo run, sem DOM)
  if (advGlobal && advGlobal.has(chaveAdv)) {
    console.log(`[api-site]   Advogado "${adv.nome}" ${oabFmt}: já adicionado neste serviço. Pulando.`);
    return;
  }

  // 2ª linha de defesa: tabela DOM (protege re-run após crash)
  if (await nomeNaTabela(page, adv.nome)) {
    console.log(`[api-site]   Advogado "${adv.nome}" ${oabFmt}: já presente na lista (DOM). Pulando.`);
    if (advGlobal) advGlobal.add(chaveAdv);
    return;
  }

  // "Advogado do Réu", "Advogado do Autor", etc. — has-text faz match case-insensitive
  const advParticipacao = `ADVOGADO DO ${participacaoSigad}`;

  const btnNovaParte = page.locator('button:has-text("Nova Parte")').first();
  await btnNovaParte.waitFor({ state: 'visible', timeout: 10000 });
  await btnNovaParte.click();
  await aguardarAjax(page);

  const inputNome = page.locator('[id="formServicoParte:inputNomeParte_input"]');
  await inputNome.waitFor({ state: 'visible', timeout: 10000 });
  await inputNome.click({ clickCount: 3 });
  await inputNome.pressSequentially(adv.nome, { delay: 80 });
  await page.waitForTimeout(1500);
  await aguardarAjax(page);

  const autoPanel = page.locator('[id="formServicoParte:inputNomeParte_panel"]');
  const encontrado = await autoPanel.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => autoPanel.locator('li:not(.ui-autocomplete-empty-message)').count())
    .then((n) => n > 0)
    .catch(() => false);

  if (encontrado) {
    await autoPanel.locator('li:not(.ui-autocomplete-empty-message)').first().click();
    await aguardarAjax(page);

    const tipoContainer = page.locator('[id="formServicoParte:inputTipoParte"]');
    await tipoContainer.locator('.ui-icon-triangle-1-s').click();
    const tipoPanel = page.locator('[id="formServicoParte:inputTipoParte_panel"]');
    await tipoPanel.waitFor({ state: 'visible', timeout: 5000 });
    // Regex ancorada com \s* tolera whitespace no textContent do li (PrimeFaces)
    const reAdvParticipacao = new RegExp('^\\s*' + advParticipacao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'iu');
    const tipoItem = tipoPanel.locator('li').filter({ hasText: reAdvParticipacao }).first();
    if ((await tipoItem.count()) > 0) {
      await tipoItem.click();
    } else {
      console.warn(`[api-site]   Participação "${advParticipacao}" não encontrada no dropdown para "${adv.nome}".`);
    }
    await aguardarAjax(page);

    console.log(`[api-site]   Advogado "${adv.nome}" ${oabFmt}: preenchido, participação="${advParticipacao}". Salvando...`);
    await salvarNovaParte(page);
    if (advGlobal) advGlobal.add(chaveAdv);
  } else {
    console.log(`[api-site]   Advogado "${adv.nome}" ${oabFmt}: não encontrado no autocomplete. Verificando cadastro em Pessoas...`);
    await fecharNovaParte(page);
    await aguardarAjax(page);

    await page.goto(PESSOAS_URL, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);

    // Fallback: pesquisa pela OAB antes de tentar criar novo cadastro
    const nomeExistenteAdv = adv.documento ? await buscarPessoaPorDoc(page, adv.documento, 'oab') : null;
    if (nomeExistenteAdv) {
      console.log(`[api-site]   Advogado "${adv.nome}": já existe em Pessoas como "${nomeExistenteAdv}". Adicionando ao serviço pelo nome cadastrado...`);
      await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
      await aguardarAjax(page);
      const tabPartesRetornoAdv = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Partes$/ }).first();
      await tabPartesRetornoAdv.waitFor({ state: 'visible', timeout: 10000 });
      await tabPartesRetornoAdv.click();
      await aguardarAjax(page);
      if (retentar) {
        const advComNomeReal = { ...adv, nome: nomeExistenteAdv };
        await processarUmAdvogado(page, advComNomeReal, participacaoSigad, numeroURL, false, advGlobal);
      }
      return;
    }

    console.log(`[api-site]   Advogado "${adv.nome}": não existe em Pessoas. Abrindo cadastro...`);

    const btnNovoIds = ['j_idt309', 'j_idt318', 'j_idt345'];
    let btnNovo = null;
    for (const id of btnNovoIds) {
      const loc = page.locator(`[id="${id}"]`);
      if (await loc.isVisible().catch(() => false)) { btnNovo = loc; break; }
    }
    if (!btnNovo) {
      for (const id of btnNovoIds) {
        try {
          const loc = page.locator(`[id="${id}"]`);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          btnNovo = loc;
          break;
        } catch {}
      }
    }
    if (!btnNovo) throw new Error('Botão Novo não encontrado (j_idt309 / j_idt318)');
    await btnNovo.click();
    await aguardarAjax(page);

    // Seleciona tipo OAB via radio button (valor 3)
    const radioValor = '3';
    await page.locator(`[name="formDados:inputPessoa"][value="${radioValor}"]`).waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate((valor) => {
      const input = document.querySelector(`input[name="formDados:inputPessoa"][value="${valor}"]`);
      if (!input) return;
      const box = input.closest('.ui-radiobutton')?.querySelector('.ui-radiobutton-box');
      (box || input).click();
    }, radioValor);
    await aguardarAjax(page);

    // Preenche número e UF da OAB
    if (adv.documento) {
      const [oabUF, oabNum] = adv.documento.split(' ');
      if (oabNum) {
        const inputOABNum = page.locator('[id="formDados:inputOABNumero"]');
        await inputOABNum.waitFor({ state: 'visible', timeout: 10000 });
        await inputOABNum.click();
        await inputOABNum.pressSequentially(oabNum, { delay: 60 });
        await page.waitForTimeout(300);
      }
      if (oabUF) {
        const inputOABUF = page.locator('[id="formDados:inputOABUF"]');
        await inputOABUF.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await inputOABUF.isVisible().catch(() => false)) {
          await inputOABUF.click();
          await inputOABUF.pressSequentially(oabUF, { delay: 60 });
          await page.waitForTimeout(300);
        }
      }
    }

    // Preenche nome
    const inputNomeFormDados = page.locator('[id="formDados:inputNome"]');
    await inputNomeFormDados.waitFor({ state: 'visible', timeout: 10000 });
    await inputNomeFormDados.click();
    await inputNomeFormDados.pressSequentially(adv.nome, { delay: 60 });
    await page.waitForTimeout(300);

    console.log(`[api-site]   Advogado "${adv.nome}" ${oabFmt}: salvando em Pessoas...`);
    await page.locator('[id="formDados:j_idt443"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[id="formDados:j_idt443"]').click();
    await aguardarAjax(page);
    console.log(`[api-site]   Advogado "${adv.nome}": cadastrado. Retornando à aba Partes...`);

    // Retorna à aba Partes do serviço
    await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);
    const tabPartes = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Partes$/ }).first();
    await tabPartes.waitFor({ state: 'visible', timeout: 10000 });
    await tabPartes.click();
    await aguardarAjax(page);

    if (retentar) {
      console.log(`[api-site]   Advogado "${adv.nome}": retentando adicionar ao serviço...`);
      await processarUmAdvogado(page, adv, participacaoSigad, numeroURL, false, advGlobal);
    } else {
      console.warn(`[api-site]   Advogado "${adv.nome}": não encontrado no autocomplete após cadastro. Verificar manualmente.`);
    }
  }
}

// Pesquisa uma pessoa na página de Pessoas pelo documento (CPF/CNPJ/OAB).
// Retorna o nome encontrado na primeira linha dos resultados, ou null se não existir.
// Deve ser chamada com a página já na PESSOAS_URL.
async function buscarPessoaPorDoc(page, documento, tipo_doc) {
  const campoId = tipo_doc === 'cnpj' ? 'formLista:j_idt348:inputCNPJ'
                : tipo_doc === 'oab'  ? 'formLista:j_idt348:inputOAB'
                :                       'formLista:j_idt348:inputCPF';

  const campo = page.locator(`[id="${campoId}"]`);
  if (!(await campo.isVisible().catch(() => false))) return null;

  // Para OAB o documento é "UF NUMERO" — usa apenas o número no campo de busca
  const valorBusca = tipo_doc === 'oab' ? (documento.split(' ')[1] ?? documento) : documento;

  await campo.click({ clickCount: 3 });
  await campo.pressSequentially(valorBusca, { delay: 60 });
  await page.waitForTimeout(300);

  await page.locator('[id="formLista:j_idt348:btnPesquisar"]').click();
  await aguardarAjax(page);

  // Cabeçalho de resultados só aparece quando há registros encontrados
  const headerResultados = page.locator('[id="formLista:j_idt348:j_idt377_header"]');
  const temResultado = await headerResultados.isVisible().catch(() => false);
  if (!temResultado) return null;

  // Lê o nome da primeira linha de dados da tabela de resultados
  const nome = await page.evaluate(() => {
    const tbody = document.querySelector('[id*="j_idt348"][id*="tabLista"] tbody, [id*="tabLista"] tbody');
    if (!tbody) return null;
    const linha = tbody.querySelector('tr.ui-widget-content, tr[data-ri="0"], tr');
    if (!linha) return null;
    for (const td of linha.querySelectorAll('td')) {
      const texto = td.textContent.trim();
      if (texto) return texto;
    }
    return null;
  });

  return nome || null;
}

async function processarUmaParte(page, servico, numeroURL, parte, retentar = true, advGlobal = null) {
  // Filtra advogados já processados neste serviço (dedup global entre partes)
  parte = {
    ...parte,
    advogados: (parte.advogados || []).filter((a) => {
      const chave = (a.nome || '').trim().toUpperCase();
      if (!chave) return false;
      if (advGlobal && advGlobal.has(chave)) return false;
      return true;
    }),
  };

  const parteJaExiste = await nomeNaTabela(page, parte.nome);

  if (parteJaExiste) {
    console.log(`[api-site] Parte "${parte.nome}": já presente na lista. Verificando advogados...`);
    const participacaoSigadExist = sigadParticipacao(parte.participacao);
    for (const adv of (parte.advogados || [])) {
      await processarUmAdvogado(page, adv, participacaoSigadExist, numeroURL, true, advGlobal);
    }
    return;
  }

  const btnNovaParte = page.locator('button:has-text("Nova Parte")').first();
  await btnNovaParte.waitFor({ state: 'visible', timeout: 10000 });
  await btnNovaParte.click();
  await aguardarAjax(page);

  const inputNome = page.locator('[id="formServicoParte:inputNomeParte_input"]');
  await inputNome.waitFor({ state: 'visible', timeout: 10000 });
  await inputNome.click({ clickCount: 3 });
  await inputNome.pressSequentially(parte.nome, { delay: 80 });
  await page.waitForTimeout(1500);
  await aguardarAjax(page);

  const autoPanel = page.locator('[id="formServicoParte:inputNomeParte_panel"]');
  const encontrada = await autoPanel.waitFor({ state: 'visible', timeout: 3000 })
    .then(() => autoPanel.locator('li:not(.ui-autocomplete-empty-message)').count())
    .then((n) => n > 0)
    .catch(() => false);

  const participacaoSigad = sigadParticipacao(parte.participacao);

  if (encontrada) {
    await autoPanel.locator('li:not(.ui-autocomplete-empty-message)').first().click();
    await aguardarAjax(page);

    const inputTipo = page.locator('[id="formServicoParte:inputTipoParte_input"]');
    await inputTipo.waitFor({ state: 'visible', timeout: 10000 });
    await inputTipo.click();
    await page.waitForTimeout(300);
    // Clicar no ícone triangular dentro do container (gravação captou o span, não o button pai)
    const tipoContainer = page.locator('[id="formServicoParte:inputTipoParte"]');
    await tipoContainer.locator('.ui-icon-triangle-1-s').click();
    const tipoPanel = page.locator('[id="formServicoParte:inputTipoParte_panel"]');
    await tipoPanel.waitFor({ state: 'visible', timeout: 5000 });
    // Regex ancorada com \s* tolera whitespace no textContent do li (PrimeFaces)
    const reParticipacao = new RegExp('^\\s*' + participacaoSigad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'iu');
    const tipoItem = tipoPanel.locator('li').filter({ hasText: reParticipacao }).first();
    if ((await tipoItem.count()) > 0) {
      await tipoItem.click();
    } else {
      console.warn(`[api-site] Participação "${participacaoSigad}" não encontrada no dropdown para "${parte.nome}".`);
    }
    await aguardarAjax(page);

    console.log(`[api-site] Parte "${parte.nome}" (${parte.tipo_doc?.toUpperCase() ?? '?'}: ${parte.documento}): preenchida, participação="${participacaoSigad}". Salvando...`);
    await salvarNovaParte(page);

    for (const adv of (parte.advogados || [])) {
      await processarUmAdvogado(page, adv, participacaoSigad, numeroURL, true, advGlobal);
    }
  } else {
    console.log(`[api-site] Parte "${parte.nome}": não encontrada no autocomplete. Verificando cadastro em Pessoas...`);
    await fecharNovaParte(page);
    await aguardarAjax(page);

    await page.goto(PESSOAS_URL, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);

    // Fallback: pesquisa pelo documento antes de tentar criar novo cadastro
    // (evita erro "documento já existe" quando a pessoa já está cadastrada sob outro nome)
    const nomeExistente = parte.documento ? await buscarPessoaPorDoc(page, parte.documento, parte.tipo_doc) : null;
    if (nomeExistente) {
      console.log(`[api-site] Parte "${parte.nome}": já existe em Pessoas como "${nomeExistente}". Adicionando ao serviço pelo nome cadastrado...`);
      await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
      await aguardarAjax(page);
      const tabPartesRetorno = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Partes$/ }).first();
      await tabPartesRetorno.waitFor({ state: 'visible', timeout: 10000 });
      await tabPartesRetorno.click();
      await aguardarAjax(page);
      if (retentar) {
        const parteComNomeReal = { ...parte, nome: nomeExistente };
        await processarUmaParte(page, servico, numeroURL, parteComNomeReal, false, advGlobal);
      }
      return;
    }

    console.log(`[api-site] Parte "${parte.nome}": não existe em Pessoas. Abrindo cadastro...`);

    // Clica em Novo para abrir o formulário de cadastro (fallback: j_idt309 | j_idt318)
    const btnNovoIds = ['j_idt309', 'j_idt318', 'j_idt345'];
    let btnNovo = null;
    for (const id of btnNovoIds) {
      const loc = page.locator(`[id="${id}"]`);
      if (await loc.isVisible().catch(() => false)) { btnNovo = loc; break; }
    }
    if (!btnNovo) {
      for (const id of btnNovoIds) {
        try {
          const loc = page.locator(`[id="${id}"]`);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          btnNovo = loc;
          break;
        } catch {}
      }
    }
    if (!btnNovo) throw new Error('Botão Novo não encontrado (j_idt309 / j_idt318)');
    await btnNovo.click();
    await aguardarAjax(page);

    // Seleciona o tipo de documento via radio button (1=CPF, 2=CNPJ, 3=OAB)
    // PrimeFaces esconde o <input> e processa eventos no .ui-radiobutton-box pai
    const radioValor = parte.tipo_doc === 'cnpj' ? '2' : parte.tipo_doc === 'oab' ? '3' : '1';
    await page.locator(`[name="formDados:inputPessoa"][value="${radioValor}"]`).waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate((valor) => {
      const input = document.querySelector(`input[name="formDados:inputPessoa"][value="${valor}"]`);
      if (!input) return;
      const box = input.closest('.ui-radiobutton')?.querySelector('.ui-radiobutton-box');
      (box || input).click();
    }, radioValor);
    await aguardarAjax(page);

    // Preenche o campo de documento conforme o tipo selecionado
    if (parte.documento) {
      if (parte.tipo_doc === 'cpf') {
        const inputCPF = page.locator('[id="formDados:inputCPF"]');
        await inputCPF.waitFor({ state: 'visible', timeout: 10000 });
        await inputCPF.click();
        await inputCPF.pressSequentially(parte.documento, { delay: 60 });
        await page.waitForTimeout(300);
      } else if (parte.tipo_doc === 'cnpj') {
        const inputCNPJ = page.locator('[id="formDados:inputCNPJ"]');
        await inputCNPJ.waitFor({ state: 'visible', timeout: 10000 });
        await inputCNPJ.click();
        await inputCNPJ.pressSequentially(parte.documento, { delay: 60 });
        await page.waitForTimeout(300);
      } else if (parte.tipo_doc === 'oab') {
        // Documento armazenado como "UF NÚMERO" (ex: "SP 12345")
        const [oabUF, oabNum] = parte.documento.split(' ');
        if (oabNum) {
          const inputOABNum = page.locator('[id="formDados:inputOABNumero"]');
          await inputOABNum.waitFor({ state: 'visible', timeout: 10000 });
          await inputOABNum.click();
          await inputOABNum.pressSequentially(oabNum, { delay: 60 });
          await page.waitForTimeout(300);
        }
        if (oabUF) {
          const inputOABUF = page.locator('[id="formDados:inputOABUF"]');
          await inputOABUF.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
          const ufVisivel = await inputOABUF.isVisible().catch(() => false);
          if (ufVisivel) {
            await inputOABUF.click();
            await inputOABUF.pressSequentially(oabUF, { delay: 60 });
            await page.waitForTimeout(300);
          }
        }
      }
    }

    // Preenche o nome
    const inputNomeFormDados = page.locator('[id="formDados:inputNome"]');
    await inputNomeFormDados.waitFor({ state: 'visible', timeout: 10000 });
    await inputNomeFormDados.click();
    await inputNomeFormDados.pressSequentially(parte.nome, { delay: 60 });
    await page.waitForTimeout(300);

    console.log(`[api-site] Parte "${parte.nome}" (${parte.tipo_doc?.toUpperCase()}: ${parte.documento}): salvando em Pessoas...`);
    await page.locator('[id="formDados:j_idt443"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[id="formDados:j_idt443"]').click();
    await aguardarAjax(page);
    console.log(`[api-site] Parte "${parte.nome}": cadastrada. Retornando à aba Partes...`);

    await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
    await aguardarAjax(page);

    const tabPartes = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Partes$/ }).first();
    await tabPartes.waitFor({ state: 'visible', timeout: 10000 });
    await tabPartes.click();
    await aguardarAjax(page);

    if (retentar) {
      console.log(`[api-site] Parte "${parte.nome}": retentando adicionar ao serviço...`);
      await processarUmaParte(page, servico, numeroURL, parte, false, advGlobal);
    } else {
      console.warn(`[api-site] Parte "${parte.nome}": não encontrada no autocomplete após cadastro. Verificar manualmente.`);
      for (const adv of (parte.advogados || [])) {
        await processarUmAdvogado(page, adv, participacaoSigad, numeroURL, true, advGlobal);
      }
    }
  }
}

async function processarPartes(page, servico, numeroURL, pPartes, onSave) {
  const grupos = carregarPartes();
  if (grupos.length === 0) {
    console.log(`[api-site] Serviço ${servico}: partes-temporarias.json vazio/ausente. Pulando aba Partes.`);
    pPartes.concluido = true;
    onSave();
    return;
  }

  const advGlobal = new Set();

  const totalMembros = grupos.reduce((acc, g) => acc + (g.membros || []).length, 0);
  console.log(`[api-site] Serviço ${servico}: processando ${grupos.length} grupo(s), ${totalMembros} membro(s). Retomando de grupo=${pPartes.grupo} membro=${pPartes.membro} fase=${pPartes.fase} adv=${pPartes.adv}`);

  const tabPartes = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Partes$/ }).first();
  await tabPartes.waitFor({ state: 'visible', timeout: 10000 });
  await tabPartes.click();
  await aguardarAjax(page);

  for (let gi = pPartes.grupo; gi < grupos.length; gi++) {
    const grupo = grupos[gi];
    const membros = grupo.membros || [];
    const advs = grupo.advogados || [];
    const esteGrupoAtual = gi === pPartes.grupo;
    const pSigad = sigadParticipacao(normalizarParticipacao(grupo.participacao));

    // --- Membros (sem advogados — processados separadamente abaixo) ---
    const skipMembros = esteGrupoAtual && pPartes.fase === 'advs';
    if (!skipMembros) {
      const startMi = esteGrupoAtual ? pPartes.membro : 0;
      for (let mi = startMi; mi < membros.length; mi++) {
        const parte = { ...membros[mi], participacao: grupo.participacao, advogados: [] };
        await processarUmaParte(page, servico, numeroURL, parte, true, advGlobal);
        pPartes.grupo = gi; pPartes.membro = mi + 1; pPartes.fase = 'parte'; pPartes.adv = 0;
        onSave();
      }
    }

    // --- Advogados do grupo (uma vez por grupo) ---
    const startAdv = (esteGrupoAtual && pPartes.fase === 'advs') ? pPartes.adv : 0;
    for (let ai = startAdv; ai < advs.length; ai++) {
      pPartes.grupo = gi; pPartes.fase = 'advs'; pPartes.adv = ai;
      onSave();
      await processarUmAdvogado(page, advs[ai], pSigad, numeroURL, true, advGlobal);
      pPartes.adv = ai + 1;
      onSave();
    }

    // Grupo concluído — avança para o próximo
    pPartes.grupo = gi + 1; pPartes.membro = 0; pPartes.fase = 'parte'; pPartes.adv = 0;
    onSave();
  }

  pPartes.concluido = true;
  onSave();
}

// Varre todos os frames da página e clica no seletor onde ele estiver visível.
// Necessário para o wizard da Pasta Digital, que carrega etapas em iframes.
async function clicarNoFrame(page, selector, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const el = frame.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          return;
        }
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`'${selector}' não ficou visível em nenhum frame após ${timeout}ms`);
}

// Detecta se a aba ESAJ foi redirecionada para a página de login/CAS
function esajSessaoExpirada(page) {
  const url = page.url();
  return url.includes('esaj.tjms.jus.br') &&
    (url.includes('sajcas') || url.includes('/login') || url.includes('sessionExpired'));
}

// Faz login ESAJ com certificado digital.
// pageExistente: se fornecida, usa essa página (sem fechar ao fim); caso contrário abre e fecha uma nova.
async function loginEsaj(context, pageExistente = null) {
  console.log('[esaj] Iniciando login com certificado digital...');
  const page      = pageExistente ?? await context.newPage();
  const fecharAoFim = !pageExistente;
  try {
    await page.goto(ESAJ_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Já autenticado (redirect automático para fora do CAS)
    if (!esajSessaoExpirada(page)) {
      console.log('[esaj] ESAJ já autenticado.');
      return true;
    }

    // Página abre em #aba-cpf por padrão — clica na aba de certificado digital
    await page.locator('#linkAbaCertificado').click();
    console.log('[esaj] Aba certificado selecionada — aguardando carregamento (5s)...');
    await new Promise((r) => setTimeout(r, 5000));

    console.log('[esaj] Clicando em Entrar...');
    await page.locator('#submitCertificado').click();

    console.log('[esaj] Aguardando redirecionamento pós-login (máx 10s)...');
    await page.waitForFunction(
      () => !window.location.href.includes('sajcas') && !window.location.href.includes('/login'),
      { timeout: 10000 }
    ).catch(() => {
      console.warn('[esaj] Timeout aguardando redirecionamento após login.');
    });

    const logado = !esajSessaoExpirada(page);
    console.log(logado ? '[esaj] Login com certificado confirmado.' : '[esaj] Login ESAJ não confirmado.');
    return logado;
  } finally {
    if (fecharAoFim) await page.close();
  }
}

// "1111111-11.1111.8.12.0000" → { campo1: "1111111-11.1111", campo2: "0000" }
function parsearNumeroProcesso(processo) {
  if (!processo) return null;
  const m = processo.trim().match(/^(\d{7}-\d{2}\.\d{4})\.\d+\.\d+\.(\d{4})$/);
  return m ? { campo1: m[1], campo2: m[2] } : null;
}

async function clicarAbaProcesso(page, servico, processo) {
  const context = page.context();
  const partes = parsearNumeroProcesso(processo);
  let novaAba = null;

  // --- Passo 3: tenta abrir via link do SIGAD ---
  const colIdx = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#formServico\\:tabela_head th')];
    return ths.findIndex((th) => th.id === 'formServico:tabela:j_idt331' || th.id === 'formServico:tabela:j_idt367');
  });

  if (colIdx >= 0) {
    const linkProcesso = page
      .locator('#formServico\\:tabela_data tr')
      .filter({ has: page.locator(`td a span:has-text("${servico}")`) })
      .first()
      .locator(`td:nth-child(${colIdx + 1}) a`)
      .first();

    try {
      [novaAba] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }),
        linkProcesso.click(),
      ]);
    } catch {
      console.warn(`[api-site] Serviço ${servico}: link Processo não abriu aba. Usando fallback pelo n°.`);
    }
  } else {
    console.warn(`[api-site] Serviço ${servico}: coluna Processo não encontrada. Usando fallback pelo n°.`);
  }

  // Fallback pelo n°: abre ESAJ diretamente se link não funcionou
  if (!novaAba) {
    if (!partes) {
      console.warn(`[api-site] Serviço ${servico}: n° de processo ausente. Pulando ESAJ.`);
      return null;
    }
    novaAba = await context.newPage();
    await novaAba.goto(ESAJ_CPOPG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    console.log(`[api-site] Serviço ${servico}: fallback n° — ESAJ aberto diretamente.`);
  } else {
    await novaAba.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }

  // Fallback de expiração: detecta redirect para login logo após abrir a aba
  if (esajSessaoExpirada(novaAba)) {
    console.warn(`[api-site] Serviço ${servico}: sessão ESAJ expirada ao abrir aba. Re-autenticando...`);
    const relogou = await loginEsaj(context);
    if (!relogou) {
      console.error(`[api-site] Serviço ${servico}: re-autenticação ESAJ falhou. Pulando processo.`);
      await novaAba.close();
      return null;
    }
    if (!partes) { await novaAba.close(); return null; }
    await novaAba.goto(ESAJ_CPOPG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  const linkPasta = novaAba.locator('#linkPasta');

  // Se o processo já está exibido (sessão ESAJ ativa), pula formulário e consulta
  const jaNoResultado = await linkPasta.isVisible().catch(() => false);

  if (!jaNoResultado) {
    // --- Preenche campos se estiverem vazios ---
    if (partes) {
      const fld1 = novaAba.locator('#numeroDigitoAnoUnificado');
      const fld2 = novaAba.locator('#foroNumeroUnificado');
      const val1 = await fld1.inputValue().catch(() => '');
      const val2 = await fld2.inputValue().catch(() => '');
      if (!val1.trim()) {
        await fld1.fill(partes.campo1);
        console.log(`[api-site] Serviço ${servico}: campo numeroDigitoAnoUnificado preenchido (${partes.campo1}).`);
      }
      if (!val2.trim()) {
        await fld2.fill(partes.campo2);
        console.log(`[api-site] Serviço ${servico}: campo foroNumeroUnificado preenchido (${partes.campo2}).`);
      }
    }

    // --- Consultar com retry ×3 para reCAPTCHA ---
    const btnConsultar = novaAba.locator(
      '#botaoConsultarProcesso, input[value="Consultar"], button:has-text("Consultar")'
    ).first();

    const btnVisivel = await btnConsultar.waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true).catch(() => false);
    if (!btnVisivel) {
      console.warn(`[api-site] Serviço ${servico}: botão Consultar não encontrado. Fechando.`);
      await novaAba.close();
      return null;
    }

    let linkPastaVisivel = false;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      await btnConsultar.click();
      await novaAba.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      console.log(`[api-site] Serviço ${servico}: Consultar clicado (tentativa ${tentativa}/3).`);

      linkPastaVisivel = await linkPasta.waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true).catch(() => false);

      if (linkPastaVisivel) break;
      console.warn(`[api-site] Serviço ${servico}: #linkPasta não visível (reCAPTCHA?). Aguardando 2s...`);
      await novaAba.waitForTimeout(2000);
    }

    if (!linkPastaVisivel) {
      console.error(`[api-site] Serviço ${servico}: #linkPasta não apareceu após 3 tentativas. Fechando.`);
      await novaAba.close();
      return null;
    }
  } else {
    console.log(`[api-site] Serviço ${servico}: processo já exibido (sessão ESAJ ativa) — pulando consulta.`);
  }

  // --- Passo 4: "Visualizar autos" → Pasta Digital ---
  // #linkPasta pode abrir nova aba ou navegar na mesma — detecta os dois casos
  const [pastaAba] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    linkPasta.click(),
  ]);
  const paginaPasta = pastaAba ?? novaAba;
  await paginaPasta.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  console.log(`[api-site] Serviço ${servico}: Pasta Digital carregada.`);

  if (esajSessaoExpirada(paginaPasta)) {
    console.warn(`[api-site] Serviço ${servico}: sessão ESAJ expirou ao abrir autos. Renovando...`);
    await loginEsaj(context);
    await paginaPasta.close().catch(() => {});
    if (pastaAba) await novaAba.close().catch(() => {});
    return null;
  }

  // --- Passo 5: seleção e download na Pasta Digital ---
  let pdfPath = null;
  try {
    // Todos os botões estão no frame principal (confirmado via recording.json).
    // Waits entre etapas espelham o timing humano — ESAJ processa cada passo via
    // AJAX e clicar antes do processamento concluir não avança o wizard.

    await paginaPasta.locator('#signatario').first().click();
    await paginaPasta.waitForTimeout(4500); // recording: ~4.4s entre signatario → selecionarButton

    await paginaPasta.locator('#selecionarButton').waitFor({ state: 'visible', timeout: 10000 });
    await paginaPasta.locator('#selecionarButton').click();
    await paginaPasta.waitForTimeout(1500); // recording: ~1.1s entre selecionarButton → salvarButton

    await paginaPasta.locator('#salvarButton').waitFor({ state: 'visible', timeout: 10000 });
    await paginaPasta.locator('#salvarButton').click();
    await paginaPasta.waitForTimeout(1500); // recording: ~1.5s entre salvarButton → botaoContinuar

    await paginaPasta.locator('#botaoContinuar').waitFor({ state: 'visible', timeout: 10000 });
    await paginaPasta.locator('#botaoContinuar').click();
    await paginaPasta.waitForTimeout(2000); // recording: ~1.5s entre botaoContinuar → buttonOk

    // #buttonOk: está no DOM mas Playwright não o vê como visible (CSS transition do ESAJ).
    // dispatchEvent contorna a checagem de visibilidade e aciona os handlers do elemento.
    await paginaPasta.locator('#buttonOk').waitFor({ state: 'attached', timeout: 10000 });
    await paginaPasta.locator('#buttonOk').dispatchEvent('click');
    await paginaPasta.waitForTimeout(4500); // recording: ~4.5s entre buttonOk → btnDownloadDocumento (geração PDF)

    // btnDownloadDocumento aparece após geração do PDF no servidor
    await paginaPasta.locator('#btnDownloadDocumento').waitFor({ state: 'visible', timeout: 150000 });
    const [download] = await Promise.all([
      paginaPasta.waitForEvent('download', { timeout: 30000 }),
      paginaPasta.locator('#btnDownloadDocumento').click(),
    ]);

    pdfPath = PROCESSO_PDF;
    await download.saveAs(pdfPath);
    console.log(`[api-site] Serviço ${servico}: PDF "${download.suggestedFilename()}" salvo → processo-temp.pdf.`);
  } catch (err) {
    console.error(`[api-site] Serviço ${servico}: erro no fluxo de download → ${err.message}`);
  }

  // --- Passo 6: fecha guia(s) ESAJ e retorna ao SIGAD ---
  await paginaPasta.waitForTimeout(1000);
  await paginaPasta.close().catch(() => {});
  if (pastaAba) await novaAba.close().catch(() => {}); // fecha aba ESAJ original se #linkPasta abriu nova
  console.log(`[api-site] Serviço ${servico}: ESAJ concluído — processo ${processo || '(sem n°)'}.`);
  return pdfPath;
}

async function aplicarFiltros(page) {
  const labelCandidatos = ['formServico:tabela:j_idt345_label', 'formServico:tabela:j_idt381_label'];
  let labelId = null;
  for (const id of labelCandidatos) {
    try {
      await page.waitForSelector(`[id="${id}"]`, { state: 'visible', timeout: 5000 });
      labelId = id;
      break;
    } catch {}
  }
  if (!labelId) throw new Error('Filtro Situação: nenhum label encontrado (j_idt345_label / j_idt381_label)');
  const panelId = labelId.replace('_label', '_panel');
  await page.locator(`[id="${labelId}"]`).click();
  const panel = page.locator(`[id="${panelId}"]`);
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  await panel.locator('li[data-label="Cadastro"], li:has-text("Cadastro")').first().click();
  await page.locator('.ui-datatable-loading').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await aguardarAjax(page);
  console.log('[api-site] Filtro "Situação = Cadastro" aplicado.');
}

// Verifica se a aba Notas já tem conteúdo sem aguardar o timeout longo de abrirNotasDetalhe.
// Retorna true se preenchida (serviço já foi iterado pela automação).
async function verificarNotasPreenchidas(page) {
  try {
    const tabNotas = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Notas$/ }).first();
    await tabNotas.waitFor({ state: 'visible', timeout: 10000 });
    await tabNotas.click();
    await aguardarAjax(page);
    await page.waitForTimeout(1000);
    const texto = await page.locator('[id="formServico"] div.ql-editor').innerText().catch(() => '');
    return texto.trim().length > 0;
  } catch {
    return false;
  }
}

// --- fluxo principal ---

async function processarServicos() {
  const { browser, context } = await abrirBrowser();
  // Usa a aba vazia deixada aberta pelo usuário; cria nova se não encontrar
  const page = context.pages().find((p) => p.url() === 'about:blank')
            ?? context.pages()[0]
            ?? await context.newPage();

  try {
    // Passo 1: Login ESAJ com certificado digital — usa a aba já aberta
    await loginEsaj(context, page);

    // Passo 2: Login SIGAD + filtros
    await garantirSessao(page, context);
    await aplicarFiltros(page);

    // Pré-carrega feriados para o ano corrente e o seguinte (BrasilAPI + algoritmo)
    const anoAtual = new Date().getFullYear();
    await inicializarFeriados([anoAtual, anoAtual + 1]);

    // Fase 1 — coleta todos os serviços ou retoma de pending.json
    let pendentes;
    let progresso;

    const dadosPending = carregarPendingDados();
    if (dadosPending) {
      const stat = fs.statSync(PENDING_FILE);
      const hojeStr = new Date().toDateString();
      const criacaoStr = new Date(stat.mtimeMs).toDateString();
      if (criacaoStr === hojeStr) {
        pendentes = dadosPending.servicos;
        progresso  = dadosPending.progresso;
        console.log(`\n[api-site] Retomando: ${pendentes.length} serviço(s) pendente(s) em pending.json.`);
      } else {
        fs.unlinkSync(PENDING_FILE);
        console.log(`\n[api-site] pending.json do dia anterior removido. Iniciando nova coleta.`);
      }
    }

    if (!pendentes) {
      console.log('\n[api-site] Fase 1 — coletando serviços...');
      const todasLinhas = [];
      let paginaNum = 1;

      while (true) {
        console.log(`[api-site] Coletando página ${paginaNum}...`);
        const linhas = await extrairLinhasDaPagina(page);
        const filtradas = FILTRO_TEOR
          ? linhas.filter((l) => l.teor.toLowerCase().includes(FILTRO_TEOR.toLowerCase()))
          : linhas;
        console.log(`[api-site] ${linhas.length} linha(s); ${filtradas.length} com filtro "${FILTRO_TEOR}".`);
        todasLinhas.push(...filtradas);

        const proximaBtn = page.locator(
          '[id="formServico:tabela_paginator_top"] .ui-paginator-next:not(.ui-state-disabled)'
        );
        if ((await proximaBtn.count()) === 0) break;
        await proximaBtn.click();
        await aguardarAjax(page);
        paginaNum++;
      }

      pendentes = todasLinhas;
      progresso  = pendentes.length > 0 ? progressoInicial(pendentes[0].servico) : null;
      salvarPendingDados(pendentes, progresso);
      console.log(`[api-site] ${pendentes.length} serviço(s) salvos em pending.json.`);
    }

    // Fase 2 — para cada serviço: abre dialog, verifica Eventos, cria se vazio
    const resultados = [];

    // Helper: salva estado atual de pendentes + progresso em disco
    const salvar = () => salvarPendingDados(pendentes, progresso);

    while (pendentes.length > 0) {
      const { servico, teor, disponibilizacao, processo } = pendentes[0];

      if (!disponibilizacao) {
        console.warn(`[api-site] Serviço ${servico}: "disponibilizacao" ausente. Pulando.`);
        pendentes.shift();
        progresso = pendentes.length > 0 ? progressoInicial(pendentes[0].servico) : null;
        salvar();
        continue;
      }

      const data = calcularDataPrevistaPrazo(disponibilizacao);
      const numeroURL = servico.replace(/\./g, '');

      // Garante sessão ativa (re-login automático se expirou)
      await garantirSessao(page, context);

      const retomando = progresso?.servico === servico;

      if (!retomando) {
        // Novo serviço — limpa arquivos temporários do anterior e reinicia progresso
        limparArquivosServico();
        progresso = progressoInicial(servico);
        salvar();

        // Verifica se as Notas já estão preenchidas (processamento manual ou execução anterior)
        await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
        await aguardarAjax(page);
        if (await verificarNotasPreenchidas(page)) {
          console.log(`[api-site] Serviço ${servico}: Notas já preenchidas. Pulando (já processado).`);
          pendentes.shift();
          progresso = pendentes.length > 0 ? progressoInicial(pendentes[0].servico) : null;
          salvar();
          await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 });
          await aguardarAjax(page);
          await aplicarFiltros(page);
          continue;
        }
      } else {
        console.log(`[api-site] Serviço ${servico}: retomando do ponto gemini=${progresso.gemini} skills=${progresso.skills} partes.concluido=${progresso.partes.concluido} evento=${progresso.evento} notas=${JSON.stringify(progresso.notas)}`);
      }

      // --- Passo 0: ESAJ + download PDF ---
      let resumo = '';
      if (!progresso.gemini) {
        // Retorna à lista para clicarAbaProcesso (precisa localizar o link na tabela SIGAD)
        await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 });
        await aguardarAjax(page);
        await aplicarFiltros(page);

        const pdfPath = await clicarAbaProcesso(page, servico, processo);

        // Navega para a página de detalhe
        await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
        await aguardarAjax(page);

        if (pdfPath) {
          console.log(`[api-site] Serviço ${servico}: gerando resumo Gemini...`);
          const resumoMd = gerarResumoGemini(pdfPath);
          try { fs.unlinkSync(pdfPath); } catch {}
          if (resumoMd) {
            resumo = resumoMd;
            fs.writeFileSync(RESUMO_FILE, resumo);
            progresso.gemini = true;
            salvar();
            console.log(`[api-site] Serviço ${servico}: resumo Gemini obtido (${resumo.length} chars). Salvo em resumo-gemini.md.`);
          } else {
            console.warn(`[api-site] Serviço ${servico}: Gemini falhou.`);
            progresso.gemini = true; // marca como tentado para não repetir
            salvar();
          }
        } else {
          console.log(`[api-site] Serviço ${servico}: PDF não disponível. Pulando Gemini.`);
          progresso.gemini = true;
          salvar();
        }
      } else {
        // Gemini já foi feito — carrega do cache em disco
        if (fs.existsSync(RESUMO_FILE)) {
          resumo = fs.readFileSync(RESUMO_FILE, 'utf-8');
          console.log(`[api-site] Serviço ${servico}: resumo Gemini carregado do cache (${resumo.length} chars).`);
        }
        // Garante que a página de detalhe está carregada
        await page.goto(`${DETAIL_BASE}${numeroURL}`, { waitUntil: 'load', timeout: 60000 });
        await aguardarAjax(page);
      }

      // --- Extrai partes (só se arquivo não existir) ---
      if (!fs.existsSync(PARTES_FILE)) {
        const partesParsed = parsearPartesDeNotas(resumo);
        if (partesParsed.length > 0) {
          fs.writeFileSync(PARTES_FILE, JSON.stringify(partesParsed, null, 2));
          const totalMembros = partesParsed.reduce((acc, g) => acc + (g.membros || []).length, 0);
          console.log(`[api-site] Serviço ${servico}: ${partesParsed.length} grupo(s), ${totalMembros} membro(s) extraído(s).`);
        } else {
          console.warn(`[api-site] Serviço ${servico}: "Relação de Partes" não encontrada.`);
        }
      }

      // --- Lança skills em background ---
      let skillsPromise;
      if (!progresso.skills) {
        if (USAR_SKILLS) {
          console.log(`[skill] Serviço ${servico}: lançando skills em background...`);
          skillsPromise = executarSkillsAsync(servico, resumo);
        } else {
          const mock = carregarMockResultado(servico) ?? {
            tipoPericia: 'NÃO CLASSIFICADO', justificativa: '',
            natureza_tabela: '', unidade_medida: '', quantidade_extraida: '',
            faixa_enquadramento: '', valor_minimo_proposto: '', valor_maximo_proposto: '',
            justificativa_extracao: '',
          };
          console.log(`[skill] Serviço ${servico}: [SIMULAÇÃO] tipoPericia="${mock.tipoPericia}" (mock)`);
          skillsPromise = Promise.resolve(mock);
        }
      } else {
        // Skills já concluídas — usa resultado salvo
        console.log(`[skill] Serviço ${servico}: resultado das skills carregado do progresso.`);
        skillsPromise = Promise.resolve(progresso.skills_resultado);
      }

      // --- Aba Partes ---
      if (!progresso.partes.concluido) {
        await processarPartes(page, servico, numeroURL, progresso.partes, salvar);
      } else {
        console.log(`[api-site] Serviço ${servico}: Partes já concluídas. Pulando.`);
      }

      // --- Aba Evento ---
      if (!progresso.evento) {
        const tabEvento = page.locator('[id="formServico"]').locator('a').filter({ hasText: /^Evento$/ }).first();
        await tabEvento.waitFor({ state: 'visible', timeout: 10000 });
        await tabEvento.click();
        await aguardarAjax(page);

        const formServico = page.locator('[id="formServico"]');
        const tabelaEvento = formServico.locator('[id$="tabListaEvento_data"]');
        await tabelaEvento.waitFor({ state: 'attached', timeout: 10000 });
        const tabelaVazia = (await tabelaEvento.locator('td.ui-datatable-empty-message, td:has-text("Nenhum evento")').count()) > 0;

        if (!tabelaVazia) {
          console.log(`[api-site] Serviço ${servico}: já existem eventos cadastrados. Pulando criação de evento.`);
        } else {
          console.log(`[api-site] Serviço ${servico}: aba Evento vazia. Criando Novo Evento...`);
          const btnNovoEvento = formServico.locator('button:has-text("Novo Evento")').first();
          await btnNovoEvento.waitFor({ state: 'visible', timeout: 10000 });
          await btnNovoEvento.click();
          await aguardarAjax(page);
          console.log(`[api-site] Serviço ${servico}: preenchendo e salvando evento para ${data}...`);
          await criarEventoEntregaProposta(page, teor, data);
        }

        progresso.evento = true;
        salvar();
      } else {
        console.log(`[api-site] Serviço ${servico}: Evento já concluído. Pulando.`);
      }

      // --- Aguarda resultado das skills ---
      let resultado;
      if (!progresso.skills) {
        console.log(`[skill] Serviço ${servico}: aguardando resultado das skills...`);
        try {
          resultado = await skillsPromise;
          console.log(`[skill] Serviço ${servico}: concluído | tipoPericia="${resultado.tipoPericia}" | honorarios="${resultado.valor_minimo_proposto} – ${resultado.valor_maximo_proposto}"`);
        } catch (err) {
          console.error(`[skill] Serviço ${servico}: erro nas skills: ${err.message}. Usando fallback.`);
          resultado = {
            tipoPericia: 'ERRO', justificativa: err.message,
            natureza_tabela: '', unidade_medida: '', quantidade_extraida: '',
            faixa_enquadramento: '', valor_minimo_proposto: '', valor_maximo_proposto: '',
            justificativa_extracao: '',
          };
        }
        progresso.skills = true;
        progresso.skills_resultado = resultado;
        salvar();
        resultados.push({ servico, ...resultado });
        fs.writeFileSync(RESULT_FILE, JSON.stringify(resultados, null, 2));
      } else {
        resultado = progresso.skills_resultado;
        resultados.push({ servico, ...resultado });
      }

      // --- Aba Notas (sub-etapas) ---
      if (!progresso.notas.salvo) {
        try {
          console.log(`[api-site] Serviço ${servico}: [notas-1] abrindo aba Notas...`);
          await abrirNotasDetalhe(page);

          if (resumo && !progresso.notas.resumo) {
            console.log(`[api-site] Serviço ${servico}: [notas-2] injetando resumo Gemini...`);
            await injetarNasNotas(page, servico, '<p><br></p><p><br></p>' + mdParaHtmlQuill(resumo), 'resumo Gemini');
            progresso.notas.resumo = true;
            salvar();
          }

          if (!progresso.notas.classificacao) {
            console.log(`[api-site] Serviço ${servico}: [notas-3] injetando classificação...`);
            const linhasClassificacao = montarLinhasClassificacao(resultado);
            await injetarNasNotas(page, servico, montarHtmlLinhas(linhasClassificacao), 'classificação');
            progresso.notas.classificacao = true;
            salvar();
          }

          console.log(`[api-site] Serviço ${servico}: [notas-4] salvando detalhes do serviço...`);
          await page.locator('[id="formServico:j_idt469"]').waitFor({ state: 'visible', timeout: 10000 });
          await page.locator('[id="formServico:j_idt469"]').click();
          await aguardarAjax(page);
          progresso.notas.salvo = true;
          salvar();
          console.log(`[api-site] Serviço ${servico}: detalhes salvos.`);
        } catch (errNotas) {
          console.error(`[api-site] Serviço ${servico}: erro ao preencher/salvar Notas: ${errNotas.message}`);
          console.error(errNotas.stack);
        }
      } else {
        console.log(`[api-site] Serviço ${servico}: Notas já salvas. Pulando.`);
      }

      // --- Serviço concluído: avança para o próximo ---
      console.log(`[api-site] Serviço ${servico}: concluído (data: ${data}).`);
      pendentes.shift();
      limparArquivosServico();
      progresso = pendentes.length > 0 ? progressoInicial(pendentes[0].servico) : null;
      salvar();

      // Retorna para a lista e reaplica filtros para o próximo serviço
      await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 });
      await aguardarAjax(page);
      await aplicarFiltros(page);
    }

    console.log('\n[api-site] Processamento concluído — todos os serviços iterados.');
    console.log(`\n[api-site] ${resultados.length} resultado(s) salvos em resultado-pericia.json`);
  } catch (err) {
    console.error('[api-site] Erro:', err.message);
  }
}

if (require.main === module) {
  processarServicos().catch((err) => {
    console.error('[api-site] Erro:', err.message);
    process.exit(1);
  });
}

module.exports = { processarServicos };
