# Fluxograma — Auto-Protocolar

Executado manualmente: `node src/web/auto-protocolar.js`
Retomada parcial (Etapa 11): `node src/web/auto-protocolar.js etapa11`

---

```
[INÍCIO]
│
├─ [1. Login ESAJ] ───────────────── certificado digital             ✔
├─ [2. Login SIGAD] ──────────────── sessão ativa ou auth.js         ✔
├─ [3. Listar serviços] ──────────── pending.json (retomável)        ✔
│
│ ╔══════════════════════════════════════════════════════════════════╗
│ ║  LOOP por serviço em pending.json                                ║
│ ║                                                                  ║
│ ║  [Etapa 2]  Aba Fases ─────────────────────────────────── ✔     ║
│ ║      Extrai Fase, Subfase, Observação                            ║
│ ║      Observação = docs esperados (separados por //)              ║
│ ║      Sem fases → pula serviço                                    ║
│ ║                                                                  ║
│ ║  [Etapa 3]  Aba Documentos ───────────────────────────── ✔      ║
│ ║      Extrai 1 ou 2 docs mais recentes (2 se há Alvará)           ║
│ ║      Não confere com Observação da Fase → pula serviço           ║
│ ║                                                                  ║
│ ║  [Etapa 4]  Dados Básicos → abre ESAJ em nova aba ──────── ✔    ║
│ ║      Retry ×3 se reCAPTCHA (#linkPasta ausente)                  ║
│ ║                                                                  ║
│ ║  [Etapa 5]  Localizar pasta no servidor ───────────────── ✔     ║
│ ║      TRABALHOS_FINAIS/<servico>/<subpasta_mais_recente>/         ║
│ ║      Extrai cabeçalho da 1ª pág do PDF                           ║
│ ║      (vara, foro, n° processo, classe, reqte, reqdo)             ║
│ ║                                                                  ║
│ ║  [Etapa 6]  Extrair partes + cabeçalho do ESAJ ────────── ✔     ║
│ ║      (paralelo) Autor + Réu; "E OUTROS" se tableTodasPartes      ║
│ ║      Cabeçalho: classe, foro, vara, n° processo — maiúsculo      ║
│ ║                                                                  ║
│ ║  [Etapa 7]  Conferir doc × ESAJ ──────────────────────── ✔      ║
│ ║      Compara: vara, foro, processo, classe, autor, réu           ║
│ ║      Divergência → notificação e-mail ⚙ pendente → pula         ║
│ ║                                                                  ║
│ ║  ┌─── Loop Peticionar (1× normal · 2× se Alvará) ─────────────┐ ║
│ ║  │  [Etapa 8]  Abrir formulário de petição ─────────── ✔       │ ║
│ ║  │  [Etapa 9]  Importar documento PDF ──────────────── ✔       │ ║
│ ║  │  [Etapa 9]  Preencher dados da petição ──────────── ✔       │ ║
│ ║  │      Peticionante: ÉRIKA PINTO NOGUEIRA                     │ ║
│ ║  │      Classificação: código por Fase/Subfase                  │ ║
│ ║  │      Solicitante: Vinicius Coutinho (01.088.089/0001-52)     │ ║
│ ║  │  [Etapa 10] Salvar para protocolar depois ─────────── ✔     │ ║
│ ║  │      (Alvará: reabre ESAJ pela Etapa 4, código 38380)        │ ║
│ ║  └──────────────────────────────────────────────────────────────┘ ║
│ ║                                                                  ║
│ ║  [Etapa 11] Encaminhar no SIGAD ──────────────────────── ✔      ║
│ ║      Editar → aba Fases → Encaminhar                            ║
│ ║      Nome: Dayane Franco Alves | Subfase: AGUARDAR PROTOCOLO     ║
│ ║      Observação: mesma da Fase → Salvar Fase → Salvar Detalhes  ║
│ ║                                                                  ║
│ ╚══════════════════════════════════════════════════════════════════╝
│
└─ [Limpeza] ─────────────── pending.json removido ao final do loop  ✔

[FIM]
```

---

## Legenda

| Símbolo | Significado |
|---------|-------------|
| `✔` | Implementado e funcional |
| `⚙ pendente` | Estrutura presente, lógica não implementada |

---

## Tabela de Classificação (Etapa 9)

| Fase | Subfase | Código | Descrição |
|------|---------|--------|-----------|
| Qualquer | `PROTOCOLAR-PRAZO` | 38423 | Dilação de prazo |
| Qualquer | `PROTOCOLAR-*` (exceto prazo) | 8822 | Manifestação do perito |
| Laudo / Esclarecimento | `PROTOCOLAR` | 38368 | Laudo |
| Outros | `PROTOCOLAR` | 8822 | Manifestação do perito |
| — | Alvará (2° doc) | 38380 | Pedido de expedição de alvará |

---

## Diretrizes para o Claude Code

1. **Seletores:** IDs `j_idt*` podem mudar entre deploys — manter fallbacks CSS com vírgula no objeto `SEL`.
2. **AJAX:** sempre chamar `aguardarAjax(page)` após interações PrimeFaces.
3. **Retomada:** se o loop for interrompido na Etapa 11, rodar `node src/web/auto-protocolar.js etapa11`.
4. **Logs:** prefixos `[etapa-2]` … `[etapa-11]` e `[peticionar]` para rastrear o ponto de falha.
