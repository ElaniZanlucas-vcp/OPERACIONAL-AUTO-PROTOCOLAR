const { login }        = require('./src/web/auth');
const { extrairDados } = require('./src/web/crawler');

async function main() {
  const fase = process.argv[2] || 'pre';

  if (fase === 'pre') {
    console.log('=== Fase PRE: Login + Extração ===');
    await login();
    await extrairDados();
    console.log('=== Fase PRE concluída. data/resultados.json gerado. ===');
    return;
  }

  console.error(`[main] Fase desconhecida: "${fase}". Use "pre".`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[main] Erro crítico:', err.message);
  process.exit(1);
});
