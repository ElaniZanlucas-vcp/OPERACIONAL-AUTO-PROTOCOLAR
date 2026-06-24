// Cálculo de datas prazo conforme Calculadora de Data Final do TJMS.
// https://sistemas.tjms.jus.br/calculadora-prazos/
//
// Passo 1 — Dias Corridos (9 dias corridos, "Incluir data de início"):
//   Base efetiva = próximo dia útil da disponibilização.
//   +8 dias corridos sobre a base efetiva (= 9 incluindo o próprio dia).
//   Se o resultado cair em não-útil, avança para o próximo dia útil.
//
// Passo 2 — Data Prazo (5 dias úteis, SEM "Incluir data de início"):
//   +5 dias úteis a partir do dia seguinte ao resultado do Passo 1.
//
// Feriados: algoritmo de Páscoa (Computus Gregoriano) + fixos nacionais +
// BrasilAPI como suplemento para pontos facultativos federais arbitrários.
// Pontos facultativos específicos do TJMS/MS não publicados em ato federal
// ficam fora do alcance automático.
// Chamar inicializarFeriados([ano, ...]) no startup para pré-carregar a API.

'use strict';

const https = require('https');

// ── Algoritmo de Páscoa ───────────────────────────────────────────────────────

function calcularPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

function _plusDias(date, n) {
  const r = new Date(date);
  r.setDate(r.getDate() + n);
  return r;
}

// ── Helpers de data ───────────────────────────────────────────────────────────

function parseDateBR(str) {
  const match = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) throw new Error(`Formato de data inválido: "${str}"`);
  const [, d, m, y] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function formatDateBR(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

// ── Base algorítmica de feriados ──────────────────────────────────────────────

function _feriadosAlgoritmo(ano) {
  const s = new Set();
  const add = (d) => s.add(formatDateBR(d));
  const dt  = (m, d) => new Date(ano, m - 1, d);

  add(dt(1,  1));  // Confraternização Universal
  add(dt(4,  21)); // Tiradentes
  add(dt(5,  1));  // Dia do Trabalhador
  add(dt(9,  7));  // Independência do Brasil
  add(dt(10, 12)); // Nossa Senhora Aparecida
  add(dt(11, 2));  // Finados
  add(dt(11, 15)); // Proclamação da República
  add(dt(11, 20)); // Consciência Negra (Lei 14.759/2023)
  add(dt(12, 25)); // Natal

  const pascoa = calcularPascoa(ano);
  add(_plusDias(pascoa, -48)); // Segunda de Carnaval  (ponto facultativo)
  add(_plusDias(pascoa, -47)); // Terça de Carnaval    (ponto facultativo)
  add(_plusDias(pascoa, -2));  // Sexta-Feira Santa
  add(_plusDias(pascoa,  60)); // Corpus Christi
  add(_plusDias(pascoa,  61)); // Dia seguinte Corpus Christi (ponto facultativo TJMS)

  return s;
}

// ── BrasilAPI — suplemento para pontos facultativos federais ─────────────────

function _buscarBrasilAPI(ano) {
  return new Promise((resolve) => {
    https.get(
      `https://brasilapi.com.br/api/feriados/v1/${ano}`,
      { headers: { 'User-Agent': 'Node.js' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).map((f) => {
              const [y, m, d] = f.date.split('-');
              return `${d}/${m}/${y}`;
            }));
          } catch { resolve([]); }
        });
      }
    ).on('error', () => resolve([]));
  });
}

// ── Cache por ano ─────────────────────────────────────────────────────────────

const _cache = {};

// Pré-carrega feriados da BrasilAPI para os anos informados e mescla com o
// algoritmo. Deve ser chamado uma vez no startup, antes do loop principal.
async function inicializarFeriados(anos) {
  for (const ano of anos) {
    if (_cache[ano]) continue;
    const algoritmo = _feriadosAlgoritmo(ano);
    let extras = [];
    try {
      extras = await _buscarBrasilAPI(ano);
    } catch {
      console.warn(`[data-prazo] BrasilAPI indisponível para ${ano}. Usando apenas algoritmo.`);
    }
    const merged = new Set(algoritmo);
    for (const d of extras) merged.add(d);
    _cache[ano] = merged;
  }
}

function _getFeriados(ano) {
  return _cache[ano] ?? _feriadosAlgoritmo(ano);
}

// ── Funções de verificação ────────────────────────────────────────────────────

function eHoliday(date) {
  return _getFeriados(date.getFullYear()).has(formatDateBR(date));
}

function eDiaUtil(date) {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && !eHoliday(date);
}

function proximoDiaUtil(date) {
  const r = new Date(date);
  while (!eDiaUtil(r)) r.setDate(r.getDate() + 1);
  return r;
}

function addCalendarDays(date, days) {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function addBusinessDays(date, days) {
  const r = new Date(date);
  let added = 0;
  while (added < days) {
    r.setDate(r.getDate() + 1);
    if (eDiaUtil(r)) added++;
  }
  return r;
}

// ── Cálculo principal ─────────────────────────────────────────────────────────

function calcularDiasCorridos(disponibilizacao) {
  const base     = proximoDiaUtil(parseDateBR(disponibilizacao));
  const resultado = addCalendarDays(base, 8);
  return proximoDiaUtil(resultado);
}

function calcularDataPrevistaPrazo(disponibilizacao) {
  return formatDateBR(addBusinessDays(calcularDiasCorridos(disponibilizacao), 5));
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  inicializarFeriados,
  calcularDataPrevistaPrazo,
  parseDateBR,
  formatDateBR,
  addCalendarDays,
  addBusinessDays,
};

// ── Testes (somente quando executado diretamente) ─────────────────────────────

if (require.main === module) {
  const DISPONIBILIZACAO = '19/06/2026';

  const CASOS = [
    { dist: '08/06/2026', prazoEsp: '23/06/2026', obs: '' },
    { dist: '12/06/2026', prazoEsp: '29/06/2026', obs: '' },
    { dist: '13/06/2026', prazoEsp: '30/06/2026', obs: 'range 13–15' },
    { dist: '15/06/2026', prazoEsp: '30/06/2026', obs: 'range 13–15' },
    { dist: '20/06/2026', prazoEsp: '07/07/2026', obs: '' },
    { dist: '03/06/2026', prazoEsp: '18/06/2026', obs: '' },
    { dist: '04/06/2026', prazoEsp: '23/06/2026', obs: 'Corpus Christi' },
    { dist: '05/06/2026', prazoEsp: '23/06/2026', obs: 'ponto facultativo' },
    { dist: '06/06/2026', prazoEsp: '23/06/2026', obs: 'sáb (range 04–08)' },
    { dist: '07/06/2026', prazoEsp: '23/06/2026', obs: 'dom (range 04–08)' },
    { dist: '08/06/2026', prazoEsp: '23/06/2026', obs: 'seg (range 04–08)' },
    { dist: '25/06/2026', prazoEsp: '10/07/2026', obs: '' },
    { dist: '19/06/2026', prazoEsp: '06/07/2026', obs: '' },
  ];

  const anosNecessarios = [...new Set(
    [DISPONIBILIZACAO, ...CASOS.map((c) => c.dist)].map((d) => Number(d.split('/')[2]))
  )];

  (async () => {
    console.log(`Carregando feriados da BrasilAPI para: ${anosNecessarios.join(', ')}...`);
    await inicializarFeriados(anosNecessarios);

    console.log(`\nDisponibilização : ${DISPONIBILIZACAO}`);
    console.log(`Data prazo       : ${calcularDataPrevistaPrazo(DISPONIBILIZACAO)}`);

    console.log('\nVerificação de exemplos:');
    let ok = 0;
    for (const { dist, prazoEsp, obs } of CASOS) {
      const prazoCalc = calcularDataPrevistaPrazo(dist);
      const pass = prazoCalc === prazoEsp;
      const nota = obs ? ` (${obs})` : '';
      console.log(`  ${pass ? '✓' : '✗'} ${dist}${nota} → ${prazoCalc} (esp ${prazoEsp})`);
      if (pass) ok++;
    }
    console.log(`\n${ok}/${CASOS.length} casos corretos.`);
  })();
}
