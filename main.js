const { login } = require('./src/web/auth');
const { extrairDados } = require('./src/web/crawler');
const { lerDadosItem, atualizarDadosParte1, atualizarDadosParte2 } = require('./src/web/api-site');
const { enviarArquivo } = require('./src/server/sincronizador');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const RESULTS_FILE = path.resolve(__dirname, 'data/resultados.json');
const WORD_SCRIPT = path.resolve(__dirname, 'src/local/manipulador_word.py');

// Chamado pelo processar-dados skill após o loop de IA (passos 4-7 por item)
async function processarItemPosSkill(item) {
  // Passo 4 — Atualizar dados no site (Parte 1)
  await atualizarDadosParte1(item);

  // Passo 5 — Editar documento Word
  const wordOutput = path.resolve(__dirname, `data/output_${item.id}.docx`);
  execFileSync('python', [WORD_SCRIPT, item.id, wordOutput], { stdio: 'inherit' });

  // Passo 6 — Sincronizar no servidor
  await enviarArquivo(wordOutput, `/destino/remoto/${item.id}.docx`);

  // Passo 7 — Atualizar outros dados no site (Parte 2)
  await atualizarDadosParte2(item);

  console.log(`[main] Item ${item.id} concluído.`);
}

async function main() {
  const fase = process.argv[2] || 'pre';

  if (fase === 'pre') {
    console.log('=== Fase PRE: Login + Extração ===');

    // Passo 1 — Autenticação
    await login();

    // Passo 2 — Acessar rota e filtrar dados
    await extrairDados();

    console.log('=== Fase PRE concluída. Aguardando skill Claude para o loop. ===');
    return;
  }

  if (fase === 'post') {
    // Recebe o item serializado como argumento (chamado pelo processar-dados skill por item)
    const itemJson = process.argv[3];
    if (!itemJson) {
      console.error('[main] Uso: node main.js post \'{"id":...}\'');
      process.exit(1);
    }
    const item = JSON.parse(itemJson);
    console.log(`=== Fase POST: Processando item ${item.id} ===`);
    await processarItemPosSkill(item);
    return;
  }

  console.error(`[main] Fase desconhecida: "${fase}". Use "pre" ou "post".`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[main] Erro crítico:', err.message);
  process.exit(1);
});
