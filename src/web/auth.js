const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const AUTH_FILE = path.resolve(__dirname, '../../data/auth.json');

async function fazerLogin(page, context) {
  const usuario = process.env.SIGAD_USUARIO;
  const senha   = process.env.SIGAD_SENHA;

  if (!usuario || !senha) {
    throw new Error('[auth] Credenciais ausentes no .env (SIGAD_USUARIO / SIGAD_SENHA).');
  }

  console.log('[auth] Preenchendo formulário de login...');

  await page.locator('input[id$="usuario"], input[name*="usuario"], input[type="text"]').first().fill(usuario);
  await page.locator('input[id$="senha"], input[name*="senha"], input[type="password"]').first().fill(senha);
  await page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Login")')
    .first()
    .click();

  const menuPaineis = page.locator('span.menuitem-text:has-text("Painéis")');
  await menuPaineis.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('load');

  const cookies = await context.cookies();
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies }, null, 2));
  console.log('[auth] Login realizado e sessão salva em data/auth.json.');
}

function loadSession() {
  if (!fs.existsSync(AUTH_FILE)) throw new Error('[auth] Sessão não encontrada. Execute fazerLogin() primeiro.');
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
}

module.exports = { fazerLogin, loadSession };
