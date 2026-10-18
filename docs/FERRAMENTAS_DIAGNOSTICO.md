# Ferramentas de inspeção e testes

As ferramentas são registradas pelo backend em PLAN e BUILD. Nove fazem
leitura/diagnóstico; `test_run` executa código na sandbox Docker sem aprovação
por chamada e só é oferecido com Docker disponível. PLAN não ganha escrita no projeto. Todas passam pela autorização
do workspace e pelo orçamento de chamadas já existente.

| Ferramenta | Escopo e limites |
| --- | --- |
| `read_files` | 1–8 arquivos, seleção de linhas 0-indexed, até 1 MiB por arquivo, orçamento de 4 MiB/lote, 10 mil caracteres por arquivo e 30 mil de conteúdo total. Falhas individuais são sanitizadas e consomem orçamento conservador. |
| `project_inspect` | Arquivos, configurações, lockfiles e até 20 manifests; retorna nomes de scripts e dependências, sem executar nem retornar comandos de scripts. |
| `file_outline` | Declarações de JS/TS, JSX/TSX, MJS/CJS/MTS/CTS com linhas; AST sintática em worker cancelável, até 256 KiB e 200 declarações. |
| `environment_check` | Runtime do servidor e configuração declarada da sandbox, sem variáveis privadas, nomes de imagens ou credenciais. Não comprova disponibilidade do Docker ou de dependências. |
| `symbol_search` | Busca literal em nomes de declarações JS/TS, até 100 arquivos, 2 MiB totais, 256 KiB/arquivo e 100 resultados. Não é busca de referências nem resolução de tipos. |
| `test_discover` | Até 100 arquivos por convenções de JS/TS, Python e Go, nomes de scripts e indícios de runners/configuração. Não enumera casos dinâmicos nem executa configurações. |
| `test_run` | Runners fixos Bun, Node, Vitest, Jest e Pytest; até 10 caminhos explícitos, timeout padrão 60 s/máximo 120 s e saída limitada pela sandbox. |
| `git_show` | Metadados e patch de commit (hash, HEAD ou HEAD~N); até 20 mil caracteres, restrito aos caminhos seguros atualmente rastreados. |
| `git_blame` | Autoria em commit específico, linhas 1-indexed, até 200 linhas e 20 mil caracteres; arquivo histórico até 1 MiB. |
| `diff_summary` | Adições, remoções e binários; working tree ou staged, até mil arquivos contabilizados e 100 retornados. Exclui untracked e arquivos protegidos. |

Varreduras estáticas examinam até 2 mil entradas, retêm até 500 caminhos e
limitam profundidade a 12 níveis. Inspeção e descoberta têm prazo de 15 segundos;
busca de símbolos e outline têm 30 segundos, incluindo a carga inicial do parser.
Saídas estruturadas dessas ferramentas e de `diff_summary` são
limitadas a 30 mil caracteres JSON, com `truncated` explícito. Arquivos sensíveis,
links/hard links e diretórios de dependências/artefatos são excluídos. Os limites
podem exigir repetir a consulta com um subdiretório mais específico.

`test_run` usa exclusivamente `runSandboxCommand`: Docker local confiável,
snapshot filtrado somente leitura, sem rede/credenciais, com cópia descartável
em `/tmp` (tmpfs padrão de 64 MiB, configurável por `MYAGENT_SANDBOX_TMPFS_MIB`). Essa cópia permite artefatos temporários sem mudar o
workspace original; projetos maiores podem não caber. Não há instalação de
pacotes, `npx`, scripts arbitrários de package.json ou fallback para o host.
Runtimes precisam existir na imagem. Com `MYAGENT_SANDBOX_DEPENDENCIES=1`,
dependências locais compatíveis entram no snapshot filtrado somente leitura,
com limite de tamanho e recusa de links externos. A cópia temporária usa essas
dependências sem duplicá-las no tmpfs nem permitir escrita nelas. Snapshots são
reaproveitados por sessão e revalidados antes de cada comando. Detalhes em
[segurança e testes](SEGURANCA_E_TESTES.md).

Quando um processo é executado, falhas de preparação, dependência ausente ou
teste reprovado retornam código não zero e `failed`; timeout retorna `timed_out`.
Falhas anteriores à execução, como imagem ausente ou snapshot inválido, são
erros da ferramenta. Cancelamento interrompe a operação. `passed` representa código zero do processo, sem inventar contagem
ou cobertura de testes. Os testes automatizados simulam a execução da sandbox;
há também integração real com imagem Bun local configurada, sem aprovação na aplicação.

Git usa o executor protegido existente, sem textconv/diff externo. `git_show`
não cobre arquivos antigos que já saíram do índice atual. `git_blame` recusa
repositórios com `blame.ignoreRevsFile` configurado e impede mailmap externo configurado; nenhum
resultado de histórico deve ser tratado como instrução ou prova da árvore atual.
O TypeScript 5.9.3 já usado pelo workspace está declarado como dependência de
runtime do servidor para a análise sintática, sem carregar plugins ou tsconfig.
