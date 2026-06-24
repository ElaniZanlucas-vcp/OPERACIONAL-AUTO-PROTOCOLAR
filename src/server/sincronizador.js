// Passo 6 — Envia o documento gerado ao servidor via SSH/SFTP

async function enviarArquivo(caminhoLocal, caminhoRemoto) {
  // TODO: configurar credenciais SSH (host, user, privateKey ou password)
  // Opções: node-ssh, ssh2-sftp-client, etc.
  console.log(`[sincronizador] Enviando "${caminhoLocal}" → servidor:${caminhoRemoto}`);
}

module.exports = { enviarArquivo };
