# Edição, leitura e busca de arquivos

`edit_file` e `write_file` preservam os bits de permissão do arquivo existente
durante a substituição atômica. Arquivos novos usam `0o644`. No POSIX, o modo
é aplicado ao temporário antes da publicação, inclusive com umask restritiva.
No Windows, a criação usa o modo existente; o sistema não representa os bits
de execução e as permissões de grupo/outros como um sistema POSIX.

`edit_file` procura `old_str` ignorando apenas a diferença entre LF e CRLF.
A substituição exige uma ocorrência única; erros informam a contagem encontrada.
O texto inserido usa o fim de linha dominante do arquivo; em empate, usa o primeiro
encontrado e, sem quebras anteriores, LF. Os trechos não editados conservam seus
bytes, inclusive em arquivos com finais de linha misturados.

`read_file` retorna numeração absoluta por padrão (`1: texto`). Use
`numbered: false` para obter texto sem prefixos. Os números não fazem parte do
arquivo e não devem ser copiados para `old_str`. `offset` começa em zero e `limit`
conta linhas. A saída usa LF e contém somente linhas completas, até 10 mil
caracteres incluindo os prefixos. Quando há mais linhas, `truncated` é verdadeiro
e `nextOffset` indica o próximo `offset`; `continuation` sugere também um `limit`.
Somente o final é omitido, sem inserir trechos do fim do arquivo no meio da página.
Páginas válidas de `read_file` permanecem inteiras no contexto enviado ao modelo
e ao recarregar mensagens persistidas enquanto houver orçamento. Quando faltar
espaço, o contexto pode encurtar a página somente no fim, em linhas completas,
atualizando `nextOffset` e a instrução de continuação; janelas muito pequenas
podem omitir pares completos, com aviso. Veja [a política de contexto](CONTEXTO_DO_MODELO.md).
Uma linha que sozinha ultrapasse o limite produz `LINE_TOO_LONG`; use `grep` para
localizar trechos menores. O limite de 5 MiB do arquivo continua valendo.

`grep` aceita `include` (glob relativo ao diretório `path`; padrões sem barra
filtram nomes em qualquer nível), `context` (0 a 20 linhas antes e depois) e
`files_only` (nomes únicos em `files`, sem trechos). As linhas de contexto ficam
em `before`/`after`, com número e texto; cada trecho tem até 300 caracteres.
A saída agregada é limitada a 60 mil caracteres, além dos limites de quantidade,
leitura e duração; `truncated` indica resultados omitidos.

`grep` e `glob` carregam o `.gitignore` da raiz do workspace a cada chamada,
mesmo quando `path` seleciona um subdiretório. A leitura aceita até 64 KiB e
2 mil regras. Comentários, escapes, padrões ancorados, diretórios e negações
seguem as regras de padrões descritas na [documentação do Git](https://git-scm.com/docs/gitignore).
Um filho não é reincluído enquanto seu pai estiver excluído. Não são consultados
`.gitignore` aninhados, exclusões globais nem o índice Git; o filtro também vale
para arquivos já versionados. Negação não libera pastas fixas ignoradas, links,
hard links ou caminhos sensíveis. O `.gitignore` também passa pela validação de
caminhos e pela leitura limitada das ferramentas.
