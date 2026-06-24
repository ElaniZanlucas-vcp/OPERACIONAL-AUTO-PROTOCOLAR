==============================
TODO: Automação Protocolar - Ordenar
==============================
$\green
- ideia: fazer um recorder.js para cada fluxograma, assim conseguimos evoluir gradualmente como foi feito para a automação do Sigad
- criar fluxos das etapas do loop

==============================
FLUXOGRAMA:

[INÍCIO DA ROTINA] (08:00 / 14:00)
1. Login Esaj, Sigad

[Início do loop]:

2. Acessar Fases 
3. Acessar Documentos p/ conferência c/ a Fase
4. Acessar Dados Básicos e clicar no Processo
4. Acessar o Servidor p/ extrair Cabeçalho do documento
5. Extrair Partes do Processo e o Cabeçalho no esaj
6. Conferência das Partes do Processo c/ Cabeçalho do Documento
7. Peticionar
8. Importação de documento 
9. Preencher Dados da Petição 
10. Salvar para protocolar depois (add condicional de Alvará p/ clicar no Processo e Peticionar - minilooping caso tenha Alvará)
11. Retorno ao sigad: Encaminhar
12. Iterar

[Fim do loop]

13. Limpeza de todos os arquivos .json (exceto auth.json por conta dos cookies) $\red {Implementar apenas após todas as verificações e rotinas}$
[FIM DA ROTINA]
===============


==============================
FLUXOGRAMA ACESSAR FASES:
==============================
1. Entrar no Serviço 
2. Clicar na aba Fases
3. Verificar o "Encaminhado por" mais recente (ou o 1° da fila)
4. Copiar Fase, Subfase e Observação
4. 1. Em Observação, estão os Documentos a serem analisados na próxima Etapa. Considere que há casos que podem conter 2 documentos, os quais são separados da seguinte forma: doc1 // doc2. O doc2 sempre será o "Alvará"




