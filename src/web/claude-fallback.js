// claude-fallback.js — Etapas 7.0 e 7.5: fallbacks de IA para a conferência do Documento × ESAJ
//
// Dois usos independentes, ambos só acionados quando os fallbacks determinísticos
// (Etapa 3.2, Etapa 7.1) já foram tentados e ainda restou divergência/campo vazio:
//
//   extrairCampoDoTexto  — Etapa 7.0: cabecalhoDoc[campo] veio vazio da extração
//                          sequencial do PDF (Etapa 5), mas o ESAJ tem um valor.
//                          Busca o valor no texto bruto do PDF.
//   avaliarSimilaridade  — Etapa 7.5: doc e ESAJ têm valores diferentes mesmo após
//                          normalizar() e (para autor/reu) o fallback tableTodasPartes.
//                          Julga se é o mesmo dado com erro de digitação/formatação
//                          ou uma diferença substantiva real.
//
// Ambas retornam sempre `confianca` — só "alta" libera o peticionamento automático
// (ver auto-protocolar.js). Qualquer erro de rede/parsing é tratado pelo chamador
// como resultado negativo (confianca "baixa"), nunca lança.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// claude-haiku-4-5: tarefa de classificação/extração curta e bem definida — testado
// contra os mesmos casos reais usados para validar o claude-sonnet-5 (ver CLAUDE.md,
// seção "Conferência (Etapa 7)") e manteve a mesma calibração de segurança: nunca
// retornou mesmoValor=true + confianca=alta num caso que deveria continuar divergente.
// Não suporta `output_config.effort` (erro 400 "This model does not support the
// effort parameter") — por isso omitido nas chamadas abaixo.
const MODEL = 'claude-haiku-4-5';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function extrairJSON(respostaTexto) {
  const bloco = respostaTexto.match(/\{[\s\S]*\}/);
  if (!bloco) throw new Error('resposta do Claude não contém um objeto JSON');
  return JSON.parse(bloco[0]);
}

const NOMES_CAMPO = {
  vara: 'a vara do processo',
  foro: 'o foro/comarca do processo',
  processo: 'o número do processo',
  classe: 'a classe processual',
  autor: 'o nome da parte autora',
  reu: 'o nome da parte ré',
};

// ── Etapa 7.5 — julgamento de similaridade (typo/formatação × diferença real) ──

const SCHEMA_SIMILARIDADE = {
  type: 'object',
  properties: {
    mesmoValor: {
      type: 'boolean',
      description: 'true se os dois textos se referem ao mesmo dado/entidade, divergindo só por erro de digitação, abreviação, pontuação ou formatação',
    },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    justificativa: { type: 'string', description: 'uma frase explicando a decisão' },
  },
  required: ['mesmoValor', 'confianca', 'justificativa'],
  additionalProperties: false,
};

async function avaliarSimilaridade({ campo, docVal, esajVal }) {
  const descricaoCampo = NOMES_CAMPO[campo] ?? campo;
  const prompt = `Você está conferindo dados extraídos de um documento jurídico (PDF) contra o mesmo dado exibido no sistema do tribunal (e-SAJ) para o mesmo processo. Os dois textos abaixo deveriam representar ${descricaoCampo}, mas a comparação automática (normalização de texto) não encontrou correspondência exata.

Texto do documento (PDF): "${docVal}"
Texto do e-SAJ: "${esajVal}"

Decida se os dois textos se referem ao MESMO dado/entidade — variando apenas por erro de digitação, abreviação, ordem das palavras, pontuação, espaçamento ou outra diferença puramente formal — ou se representam uma diferença SUBSTANTIVA real (pessoa/empresa diferente, número diferente, vara/comarca diferente, classe processual diferente).

Seja conservador: em caso de dúvida real sobre se é a mesma entidade, prefira mesmoValor=false ou confianca não-alta. Retorne confianca="alta" apenas quando tiver certeza de que a diferença é puramente formal.`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_SIMILARIDADE },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    return { mesmoValor: false, confianca: 'baixa', justificativa: 'consulta recusada pelo modelo' };
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('resposta do Claude sem bloco de texto');
  return extrairJSON(textBlock.text);
}

// ── Etapa 7.0 — recuperação de campo vazio a partir do texto bruto do PDF ──────

const SCHEMA_EXTRACAO = {
  type: 'object',
  properties: {
    valorEncontrado: {
      type: ['string', 'null'],
      description: 'o valor do campo encontrado no texto, ou null se não aparecer no texto',
    },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    justificativa: { type: 'string', description: 'uma frase explicando onde/como o valor foi localizado, ou por que não foi encontrado' },
  },
  required: ['valorEncontrado', 'confianca', 'justificativa'],
  additionalProperties: false,
};

const LIMITE_TEXTO_DOCUMENTO = 6000; // caracteres — cabeçalho do documento está sempre no início

async function extrairCampoDoTexto({ campo, textoDocumento, valorEsaj }) {
  const descricaoCampo = NOMES_CAMPO[campo] ?? campo;
  const trecho = (textoDocumento || '').slice(0, LIMITE_TEXTO_DOCUMENTO);
  const prompt = `Abaixo está o texto bruto extraído da primeira página de uma petição/documento jurídico. A extração automática por regras não conseguiu localizar ${descricaoCampo} nesse texto.

Para referência, o e-SAJ (sistema do tribunal) tem o seguinte valor cadastrado para esse mesmo campo, no mesmo processo: "${valorEsaj}"

Texto do documento:
"""
${trecho}
"""

Procure no texto o valor correspondente a ${descricaoCampo}. Retorne o valor exatamente como aparece no texto (não copie o valor do e-SAJ — ele é só uma referência do que procurar). Se o campo realmente não aparecer no texto, retorne valorEncontrado=null.`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_EXTRACAO },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    return { valorEncontrado: null, confianca: 'baixa', justificativa: 'consulta recusada pelo modelo' };
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('resposta do Claude sem bloco de texto');
  return extrairJSON(textBlock.text);
}

module.exports = { avaliarSimilaridade, extrairCampoDoTexto };
