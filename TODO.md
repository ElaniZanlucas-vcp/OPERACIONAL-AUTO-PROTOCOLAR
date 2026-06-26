==============================
TODO: Automação Protocolar - Ordenar
==============================
$\green ✔$
- ideia: fazer um recorder.js para cada fluxograma, assim conseguimos evoluir gradualmente como foi feito para a automação do Sigad
- criar fluxos das etapas do loop
- ajustar nome dos arq.js

==============================
FLUXOGRAMA:

[INÍCIO DA ROTINA] (08:00 / 14:00)
1. Login Esaj, Sigad $\green ✔$

[Início do loop]:

2. Acessar Fases $\green ✔$
3. Acessar Documentos p/ conferência c/ a Fase $\green ✔$
4. Acessar Dados Básicos e clicar no Processo $\green ✔$
5. Acessar o Servidor p/ extrair Cabeçalho do documento $\orange {verificar outros docs}$
6. Extrair Partes do Processo e o Cabeçalho no esaj $\green ✔$
[Loop Alvará]
7. Conferência das Partes do Processo c/ Cabeçalho do Documento e Peticionar
8. Importação de documento 
9. Preencher Dados da Petição 
10. Salvar para protocolar depois (add condicional de Alvará p/ clicar no Processo e Peticionar - minilooping caso tenha Alvará)
[Fim Loop Alvará]
11. Retorno ao sigad: Encaminhar $\green ✔$
12. Iterar

[Fim do loop]

13. Limpeza de todos os arquivos .json (exceto auth.json por conta dos cookies) $\red {Implementar apenas após todas as verificações e rotinas}$
[FIM DA ROTINA]
===============

Vamos criar o fluxograma inicial utilizando o recorder.js. Desta vez o target_url do sigad é na página principal (https://sistemas.vcpericia.com.br/sigad/inicio/index.xhtml). 
Vamos mostrar o fluxo até a etapa 4 e seremos redirecionados para o esaj (para começar a etapa 6). Deixe 10s de inatividade para parar o recorder. Após isso explicaremos oq extrair em cada etapa.
============================== 
[ETAPA-2] FLUXOGRAMA ACESSAR FASES:  $\green ✔$
==============================
1. Entrar no Serviço 
2. Clicar na aba Fases
3. Verificar o 1° da fila (mais recente) ou "Encaminhado por"
4. Copiar Fase, Subfase e Observação
4. 1. Em Observação, estão os Documentos a serem analisados na próxima Etapa. Considere que há casos que podem conter 2 documentos, os quais são separados da seguinte forma: doc1 // doc2. O doc2 sempre será o "Alvará"


==============================
[ETAPA-3] FLUXOGRAMA ACESSAR DOCUMENTOS:  $\green ✔$
==============================
1. Clicar na aba Documentos
2. Copiar Documento mais recente
2. 1. Caso exista Alvará, copiar os 2 Documentos mais recentes
3. Verificar se os documentos encontrados batem com os documentos extraídos de Fase no campo Observação (doc1 // doc2 na Fase trata-se de doc1, doc2 considerando a ordem pelo mais recente nos Documentos)
3. 1. Em caso positivo, continuar o fluxo para a próxima etapa
3. 2. Em caso negativo, o fluxo termina aqui $\orange {ajustar}$


==============================
[ETAPA-4] FLUXOGRAMA ACESSAR DADOS BÁSICOS:  $\green ✔$
============================== 
1. Clicar na aba Dados Básicos
2. Clicar no processo (uma nova guia será aberta com a guia do esaj no processo)


==============================
[ETAPA-5] FLUXOGRAMA ACESSAR SERVIDOR (Trabalhos Finais): $\orange {verificar outros docs formato cabeçalho}$
==============================
- Acessar pelo path?
- Compensa chamar Gemini API p/ olhar Cabeçalho do documento e rodapés? Forma + simples?
- Condicional Alvará -> verificar nome do doc
- Como fazer a extração de dados?


Agora vamos fazer a Etapa 5. O script precisa abrir a pasta no Servidor chamada "Trabalhos Finais", pesquisar o n° do Serviço e Abrir esta pasta e por último abrir a pasta mais recente, que é onde conterá o documento para a extração da primeira página.

==============================
[ETAPA-6] FLUXOGRAMA PARTES DO PROCESSO E EXTRAIR CABEÇALHO NO ESAJ (ETAPA 6) $\green ✔$
==============================
- [extrair Partes do Processo] - 
Baseie-se na extração feita por teste-partes.js. É preciso extrair apenas Autor e Réu, sem os advogados. Considere apenas nomes em tablePartesPrincipais. Caso exista tableTodasPartes, complemente o retorno da Parte com "E OUTROS". 
Ex:
Autor: Fulano de Tal
Autora: Beltrana
Réu: Chiquinho

Retorno:
Autor: FULANO DE TAL E OUTROS
RÉU: CHIQUINHO

- [extrair Cabeçalho] - 
Estes são os novos dados a serem extraidos:
- n° do Processo, Classe, Foro e Vara

Ao final da extração, todos os dados devem estar em maiúsculo para fins de comparação.



==============================
[ETAPA-7] PETICIONAR OU RETORNAR: 
==============================
1. Com a extração de dados do documento e do esaj, conferimos se os dados estão batendo corretamente  $\green ✔$
Mostraremos um exemplo de verificação dos dados a partir do Documento em Trabalhos Finais. Os termos dentro de {} são os termos a serem comparados dos dados extraídos do esaj.

1ª página do Documento:
"AO JUÍZO DA {Vara} DA COMARCA DE {Foro}" -> Vara, Foro
AUTOS: {n° Processo}
AÇÃO: {Classe}
REQTE: {Autora}
REQDO: {Réu} 

Obs: Lembre-se das variações de Autor e Réu em Siglas existentes no Sigad. O mais importante é verificar se os nomes condizem, sendo assim, lembrar que pode haver variações de acento, pontuação e /.

2. 1. Em caso positivo, Peticionar (por enquanto, vamos apenas implementar o caso positivo) $\green ✔$
2. 2. Em caso negativo, Retornar/Encaminhar (pra quem?) para que seja corrigido
- Add condicional para quando tiver Alvará (o loop inicia aqui e finaliza ao Salvar para Protocolar depois)

OBS: A etapa 7.1 já está funcionando, então não é necessário alterar
==============================

Agora que a comparação está funcionando, vamos fazer as implementações de 7.2
Primeiramente, vamos implementar o caso negativo (Retornar):
Quando a comparação falha, seguiremos o sguinte fluxo:
1. Abriremos o gmail
2. Iniciaremos um "Novo Chat" com o Responsável do documento da seguinte forma:
    2. 1. Clique em "Novo Chat"
    2. 2. Pesquise o Responsável e clique em "Iniciar Chat"
3. Enviaremos uma mensagem informando as divergências encontradas e pedindo a alteração
4. O fluxo termina aqui 

Caso seja mais fácil, o plugin do gmail ajudaria?

(deste serviço)

==============================
[ETAPA-8] FLUXOGRAMA IMPORTAÇÃO DE DOCUMENTO: $\green ✔$
==============================
1. O path a ser acessado é o mesmo que o acessado na Etapa 5
2. O primeiro import sempre deve ser o doc != de Alvará, ou seja, a segunda execução do loop de peticionar é para o Alvará

==============================
[ETAPA-9] FLUXOGRAMA PREENCHER DADOS DA PETIÇÃO:
==============================
PETICIONANTE: ÉRIKA PINTO NOGUEIRA (ÉRIKA PINTO NOGUEIRA - Advogado(a))

CLASSIFICAÇÃO:
|-----------------------+--------------------+-----------+-------------------------|
|         Fase          |       SubFase      |    Cod    |      Descrição Cod      |
|-----------------------+--------------------+-----------+-------------------------|
|        Nomeação       |     Protocolar     |    8822   |  Manifestação do perito | 
|-----------------------+--------------------+-----------+-------------------------|
|        Intimação      |     Protocolar     |    8822   |  Manifestação do perito | 
|-----------------------+--------------------+-----------+-------------------------|
|       De ofício       |     Protocolar     |    8822   |  Manifestação do perito | 
|-----------------------+--------------------+-----------+-------------------------|
|         Laudo         |     Protocolar     |   38368   |         Laudo           |
|-----------------------+--------------------+-----------+-------------------------|
|    Esclarecimento     |     Protocolar     |   38368   |  Manifestação do laudo  | 
|-----------------------+--------------------+-----------+-------------------------|
|  Laudo/Esclarecimento |     Protocolar-*   |    8822   |  Manifestação do perito | 
|-----------------------+--------------------+-----------+-------------------------|
|  Laudo/Esclarecimento |  Protocolar-prazo  |   38423   |     Dilação de prazo    |
|-----------------------+--------------------+-----------+-------------------------|

*[diligente, inconclusivo, solicitação de documento]

Obs: Alvará pode existir apenas caso Fase seja Intimação, Laudo ou Esclarecimento. Seu código é 38380: Pedido de expedição de alvará
Se o código não estiver nas Sugestões, um outro fluxo deve ser seguido: O script deve clicar em fechar nas Sugestões e utilizar a barra de pesquisa para buscar pelo cod. Com isso o fluxo segue.

SOLICITANTE (polo_represent_list): Vinicius Coutinho Consultoria e Perícia S/S Ltda (polo_represent_list_item_name) 01.088.089/0001-52 (polo_represent_list_item_number)


==============================
[ETAPA-10] FLUXOGRAMA SALVAR PARA PROTOCOLAR DEPOIS:
==============================
1. Para fins de teste, vamos fazer a seguinte condição para o Alvará:
1. 1. Caso tenha Alvará, após preencher todos os dados acima, vamos clicar no span numeroProcesso para sermos novamente redirecionados para a capa do processo no esaj e fazermos o mesmo fluxo (8 a 10) para Alvará.
1. 2. Caso não tenha, após preenchermos todos os dados acima, vamos aguardar 10s e clicar em Fechar.
==============================

1.  Salvar para protocolar depois

(add condicional de Alvará p/ clicar no Processo e Peticionar - minilooping caso tenha Alvará)

Obs: para fins de teste, podemos fazer o recorder clicar em Fechar. Assim ele acha o footer corretamente e seria só atualizar o id para Salvar depois.

==============================
[ETAPA-11] FLUXOGRAMA SIGAD - ENCAMINHAR:  $\green ✔$
==============================
1. Retorno ao sigad
2. Ir para Detalhes do Serviço, Fases e clicar em Encaminhar
3. Preencher os campos conforme está abaixo, clicar em Encaminhar e salvar os detalhes
    Nome: Dayane Franco Alves
    Fase: não é alterada
    Subfase: Aguardar Protocolo
    Observação: mesma Observação de Fase

==============================

Atualize o recorder.js para fazer o fluxo de auto-protocolar. Assim conseguimos mostrar corretamente o funcionamento das Etapas 8 a 10 para implementá-las em sequência.


