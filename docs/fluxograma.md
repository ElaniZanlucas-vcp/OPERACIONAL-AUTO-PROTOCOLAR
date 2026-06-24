# Fluxograma da Rotina Diária

Agendamento: segunda a sexta, 08:00 e 14:00 (America/Sao_Paulo).
Cron: `0 8,14 * * 1-5` — configurado em `.claude/routines/rotina-diaria.json` (comentado até todos os stubs serem implementados).

---

```
[INÍCIO DA ROTINA] (08:00 / 14:00)
│
├─ [1. Login] ─────────────────────────────── src/web/auth.js            ✔ implementado
│      Valida sessão existente (auth.json) ou faz login e salva cookies.
│
├─ [2. Acessar Rota e Filtrar Dados] ─────── src/web/crawler.js          ✔ implementado
│      Aplica filtro Situação = Cadastro → extrai todas as páginas
│      → data/resultados.json  ({ servico, teor, disponibilizacao, processo })
│
│ ╔══════════════════════════════════════════════════════════════════════╗
│ ║  LOOP por item em data/resultados.json  (controle: pending.json)     ║
│ ║                                                                      ║
│ ║  [3. Baixar o processo] ────────────────── ESAJ / clicarAbaProcesso  ║
│ ║       Abre guia ESAJ, preenche campos se vazios, clica Consultar     ║
│ ║       (retry ×3 se reCAPTCHA), clica Visualizar Autos, aguarda 3s.   ║
│ ║       [Gemini p/ resumo] ────────────────────────────── ⚙ pendente   ║
│ ║                                                                      ║
│ ║  [4. Chamada Gemini p/ resumo do processo] ─────────── ⚙ pendente   ║
│ ║                                                                      ║
│ ║  [5. Chamada skill-tipo-pericia] ──────────────────────── ✔         ║
│ ║       Classifica o processo em um dos ~70 tipos de perícia.          ║
│ ║                                                                      ║
│ ║  [6. Chamada skill-proposta-honorarios] ───────────────── ✔          ║
│ ║       Calcula faixa de honorários com base no tipo e na matriz.      ║
│ ║                                                                      ║
│ ║  [7. Preencher Notas] ─────────────────────────────────── ✔          ║
│ ║       Escreve classificação + proposta no campo Notas do SIGAD.      ║
│ ║                                                                      ║
│ ║  [8. Preencher Partes] ────────────────────────────────── ✔ simulado ║
│ ║       Parser extrai partes e advogados das Notas →                   ║
│ ║       preenche aba Partes; Cadastro no SIGAD se não encontrado.      ║
│ ║       [UI de advogado ainda não mapeada — simulação]                 ║
│ ║                                                                      ║
│ ║  [9. Add Evento — Entrega Proposta] ───────────────────── ✔ simulado ║
│ ║       Cria evento ENTREGA PROPOSTA com Data Prevista + Prazo.        ║
│ ║       [Formulário preenchido mas não salvo em simulação]             ║
│ ║                                                                      ║
│ ║  [10. Iterar para o próximo item] ─────────────────────── ✔          ║
│ ║       Remove item do pending.json; continua até lista vazia.         ║
│ ╚══════════════════════════════════════════════════════════════════════╝
│
├─ [11. Limpeza dos arquivos .json] ──────────────────────── ✘ pendente
│       Remove resultados.json, pending.json, partes-temporarias.json.
│       auth.json é mantido (cookies de sessão).
│       Implementar APENAS após todas as verificações e rotinas.
│
[FIM DA ROTINA]
```

---

## Legenda

| Símbolo | Significado |
|---------|-------------|
| `✔ implementado` | Funcional e testado |
| `✔ simulado` | Funcional, mas sem salvar/confirmar no SIGAD (modo seguro) |
| `⚙ pendente` | Estrutura criada, lógica interna não implementada |
| `✘ pendente` | Ainda não iniciado — aguarda conclusão de etapas anteriores |

---

## Diretrizes para o Claude Code

1. **Orquestração:** iniciar conforme `processar-dados.md` (skill de orquestração).
2. **Consumo de tokens:** Claude Code só intervém nos Passos 5 e 6 (skills). Todo o resto é Playwright/Node puro.
3. **Logs:** prefixos `[auth]`, `[crawler]`, `[api-site]`, `[recorder]`, `[main]` para monitoramento.
4. **Retomada:** se o loop for interrompido, a próxima execução continua de onde parou via `pending.json`.
