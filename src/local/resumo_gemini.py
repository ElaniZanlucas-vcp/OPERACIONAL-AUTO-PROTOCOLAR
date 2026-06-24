"""Gera resumo de processo judicial via Gemini API e imprime Markdown no stdout."""
import os
import sys
import json
import PyPDF2
import requests

# Força UTF-8 no stdout independente da locale do Windows (evita CP1252 default)
sys.stdout.reconfigure(encoding='utf-8')

API_KEY = os.getenv('GEMINI_API_KEY')
if not API_KEY:
    print('GEMINI_API_KEY não definida.', file=sys.stderr)
    sys.exit(1)

GEMINI_MODEL = 'gemini-3.1-pro-preview'
GEMINI_API_URL = (
    f'https://generativelanguage.googleapis.com/v1beta/models/'
    f'{GEMINI_MODEL}:generateContent?key={API_KEY}'
)

PRE_PROMPT_RESUMO = """
        Perfil:

        Você é um especialista em análise jurídica. Sua tarefa é criar um resumo de um processo judicial (anexo fornecido).

        Você possui um profundo conhecimento do direito brasileiro e está inteiramente atualizado no âmbito jurídico. Suas respostas são precisas, objetivas e confiáveis, baseadas única e exclusivamente no anexo fornecido. Você apresenta apenas dados dos quais tem absoluta certeza, sem adicionar nem criar novos conteúdos.

        Tarefa:

        Elaborar um resumo detalhado, informativo e abrangente do processo judicial, extraindo exclusivamente as informações contidas no anexo.

        Passo 1: Análise do Anexo

        - Realize uma leitura cuidadosa de todas as páginas do anexo fornecido da primeira à última.

        Passo 2: Composição do Resumo

        - Inicie o resumo com um cabeçalho que inclua o número do processo e as páginas do documento analisadas (ex.: páginas 1 a 100).

        Passo 3: Detalhes Específicos

        - Resumo do Processo
        - Descrição do Objetivo da Perícia: Explique a finalidade e a necessidade da perícia.
        - Valor da causa
        - Descrição do Imóvel ou Documento Periciado: Forneça uma descrição detalhada do imóvel ou documento a ser periciado, incluindo a quantidade de cada item, mencionando a página específica do processo que contém a informação.
        - Nome do Perito Nomeado: Informe o nome do perito e a página de sua nomeação.
        - Quesitos Formulados: Indique a página onde estão os quesitos das partes e do juiz, se houver.
        - Assistentes Técnicos: Liste os nomes dos assistentes técnicos e a página da indicação.
        - Responsável pelo Pagamento do Perito: Identifique a parte responsável e a página onde consta a informação, informando se essa parte é beneficiária da justiça gratuita.
        - ⚠️ PRAZO PARA ENTREGA DO LAUDO: Busque em todo o processo por qualquer fixação de prazo para a entrega do laudo pericial. Procure por termos como "prazo para entrega do laudo", "prazo para apresentação do laudo", "prazo para conclusão da perícia", "o perito terá X dias", "determino prazo de X dias", "concedo prazo de X dias" ou qualquer decisão judicial que estipule um prazo ao perito. Se encontrado, destaque em negrito a data-limite ou o número de dias e informe a página. Se não houver prazo fixado, escreva explicitamente: "Nenhum prazo fixado para entrega do laudo identificado no processo."
        - Relação de Todas as Partes Envolvidas: Liste todas as partes processuais, incluindo CPF/CNPJ, advogados e números da OAB. Siga as regras abaixo:
            a) Não inclua o perito nomeado (já consta em "Nome do Perito Nomeado").
            b) Na linha "Participação:", informe apenas o papel processual principal e simples (ex.: "Autor", "Ré", "Requerente", "Requerido", "Terceiro Interessado") — nunca acrescente qualificadores como "e Reconvindo", "e Reconvinte", "(Reconvindo)" ou similares.
            c) Agrupe todas as pessoas com o mesmo papel em um único bloco "Participação:" (nunca repita o mesmo papel em blocos separados). Os advogados são da participação inteira — liste-os uma única vez por bloco.
            d) Representantes Legais (pessoas físicas que representam uma parte, como sócios, diretores ou representantes de empresas ou espólios): liste-os em bloco separado com "Participação: Representante Legal", vinculados à parte que representam. Representantes Legais NÃO possuem advogados próprios neste bloco.
            e) Espólios devem ser listados com o nome completo "Espólio de [Nome]", como qualquer outra parte.
            Siga sempre esse formato:
            Participação: Autor
            - Nome: Fulano de Tal (CPF: 000.000.000-00)
            - Nome: Empresa Exemplo Ltda. (CNPJ: 00.000.000/0001-00)
            - Advogado da Participação:
                    - Nome Completo (OAB/UF nº 00000)
                    - Nome Completo (OAB/UF nº 11111)
            Participação: Ré
            - Nome: Espólio de João da Silva (CPF: 111.111.111-11)
            - Advogado da Participação:
                    - Nome Completo (OAB/UF nº 22222)
            Participação: Representante Legal
            - Nome: Maria Silva (CPF: 222.222.222-22)

        Contexto:

        Mantenha o contexto durante toda a conversa, garantindo que as ideias e respostas estejam relacionadas ao arquivo anexado.

        Formato:

        - Utilize linguagem clara, objetiva e formal.
        - Estruture o texto com parágrafos, títulos e subtítulos para facilitar a leitura.
        - Mantenha a concisão, evitando repetições desnecessárias.
        - Assegure um padrão consistente de formatação para uniformidade.
        - A seção "⚠️ PRAZO PARA ENTREGA DO LAUDO" deve sempre aparecer imediatamente antes da seção "Relação de Todas as Partes Envolvidas" e ser formatada em destaque (negrito e emoji ⚠️ no título).

        Finalização:

        - Revise o resumo para garantir precisão e clareza das informações.
        - Certifique-se de que o tom seja formal e profissional, com precisão na apresentação dos dados.
        """


def extrair_texto_pdf(caminho_pdf):
    texto = ''
    with open(caminho_pdf, 'rb') as f:
        reader = PyPDF2.PdfReader(f)
        for pagina in reader.pages:
            texto += pagina.extract_text() or ''
    return texto


def chamar_gemini(texto_pdf):
    full_prompt = PRE_PROMPT_RESUMO + texto_pdf
    params = {'contents': [{'parts': [{'text': full_prompt}]}]}
    headers = {'Content-Type': 'application/json'}
    resp = requests.post(GEMINI_API_URL, headers=headers, json=params, timeout=600)
    resp.raise_for_status()
    data = resp.json()
    return data['candidates'][0]['content']['parts'][0]['text']


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Uso: python resumo_gemini.py <caminho_pdf>', file=sys.stderr)
        sys.exit(1)

    caminho_pdf = sys.argv[1]
    if not os.path.isfile(caminho_pdf):
        print(f'Arquivo não encontrado: {caminho_pdf}', file=sys.stderr)
        sys.exit(1)

    try:
        texto = extrair_texto_pdf(caminho_pdf)
    except Exception as e:
        print(f'Erro ao ler PDF: {e}', file=sys.stderr)
        sys.exit(1)

    try:
        resumo = chamar_gemini(texto)
    except Exception as e:
        print(f'Erro ao chamar Gemini: {e}', file=sys.stderr)
        sys.exit(1)

    print(resumo)
