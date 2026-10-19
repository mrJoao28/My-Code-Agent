# Aprovações e desfazer

A CUI mostra a ação antes de executá-la: comando em bash, substituição em diff
para edit_file, diff unificado de apply_patch, caminho/tamanho em bytes/prévia
para write_file, URL completa para web_fetch e origem/destino para movimentos
ou exclusões. Linhas removidas ficam vermelhas, adicionadas verdes. Setas e
PgUp/PgDn rolam o pedido; mouse também permite escolher as opções.
Prévias têm limite de 1000 linhas e 80 mil caracteres, com aviso explícito;
para revisar tudo nesses casos, negue e peça alterações menores.

- Y: permitir uma vez.
- A: permitir nesta sessão, somente para a ferramenta e o escopo exibidos.
- N: negar.
- Esc ou Ctrl+C: interromper a geração. Enter e Tab não aprovam.

Um diálogo aberto continua tendo prioridade de teclado. O campo de mensagem
fica sem foco durante a aprovação; não há troca de modo por Tab nesse painel.
A mudança de modo para uma próxima mensagem não altera uma geração em andamento.

Permissões A vivem em memória no ApprovalManager, por sessionId. Para arquivos,
o escopo é o conjunto exato de caminhos, incluindo origem/destino e backups;
não libera uma pasta inteira nem outra ferramenta ou workspace. Para web_fetch,
vale a origem web aprovada (domínio, protocolo e porta), incluindo outros caminhos
nessa origem, sem incluir subdomínios. Redirecionamentos para outra origem são
recusados com instrução para fazer nova chamada, permitindo aprovar o novo destino.
git_commit, delete_file, git_init, git_remote_add e git_push sempre pedem aprovação
individual. Push exibe a URL completa e a branch; para main/master, Y abre uma
segunda confirmação e M autoriza explicitamente. Em `exec`, `--approve all`
precisa também de `--allow-push`, que não confirma main/master. Há até 256 escopos
por sessão. As permissões acabam com o processo ou com a retenção da sessão;
autorização do workspace, validação de caminhos e cancelamento são rechecados.
Não se reaproveita aprovação expirada ou negada. Comandos de diagnóstico na
sandbox continuam dispensando aprovação; o painel suporta bash quando solicitado
por uma política que exija consentimento, sem mudar a política atual.

## Checkpoints

Antes de write_file, edit_file, delete_file, move_file e apply_patch em BUILD,
o executor salva a pré-imagem em ~/.myagent/checkpoints/<sessionId>/, usando
MYAGENT_HOME ou o alias legado como diretório global quando configurado.
São arquivos privados do aplicativo, sem git add, commit ou alteração do índice.
A pré-imagem guarda os bytes exatos e o modo do arquivo, inclusive CRLF,
conteúdo binário, arquivos ainda não rastreados e alterações preexistentes.
write_file com backup inclui .bak; movimentos incluem origem e destino;
patches com vários arquivos são um único passo. checkOnly não cria um passo.

Limites: 5 MiB por arquivo, 20 MiB de bytes por passo, 1000 entradas e 32 níveis,
até 20 passos recentes e 64 MiB de armazenamento por sessão. Reservas conservadoras
consideram conteúdo novo e metadados antes de permitir a escrita; alterações
próximas do limite podem precisar ser divididas. Checkpoints completos mais antigos
são descartados para manter esses limites. Um passo incompleto não é descartado
automaticamente para abrir espaço. Links/junctions, hard links, caminhos sensíveis
e a raiz do workspace são recusados. Armazenamento sem espaço ou sem permissão
impede a ação antes de escrever no projeto. Falhas sem alteração não criam passos
fantasmas; uma ferramenta que falhou depois de alterar algo ainda registra o estado
posterior quando ele pode ser lido com segurança.

## /undo

Digite /undo ou escolha o comando no menu. Ele é uma ação local explícita do
usuário, sem chamada ao modelo, e exige uma sessão válida e workspace autorizado.
Não funciona enquanto a mesma sessão está gerando. Escritas e restaurações no
mesmo workspace são serializadas dentro do processo; leases continuam protegendo
a sessão entre processos.

Antes de desfazer, o servidor verifica todos os caminhos do último passo usando
SHA-256 dos bytes, modo, estrutura, inode, mtime e ctime dos arquivos. Qualquer
mudança, recriação, conteúdo extra ou caminho inseguro causa conflito antes da
restauração; a CUI informa os caminhos e mantém o checkpoint. Não há opção de
forçar sobrescrita. Depois de resolver o conflito externamente, tente de novo
somente se tiver certeza de que restaurar o estado posterior é o desejado.

Uma restauração bem-sucedida remove arquivos criados, repõe os removidos e os
conteúdos/modos anteriores, e permite continuar desfazendo os passos anteriores.
Diretórios criados pela ação também são removidos quando fazem parte do passo.
O resultado de /undo é persistido como mensagem de texto no histórico, com aviso
para reler os arquivos antes de continuar. Essa nota invalida as evidências antigas
do guard de chamadas, permitindo releituras sem zerar o orçamento total. Resultados de ferramentas preservam
o identificador do checkpoint e a decisão de aprovação quando disponíveis;
aprovações pendentes são eventos transitórios e não são reapresentadas no reload.

A verificação de conflitos acontece antes das escritas, mas filesystem não oferece
transação atômica para vários arquivos. Falha de I/O durante a restauração pode
exigir recuperação pelas pré-imagens preservadas; não há fallback destrutivo nem
execução no host para contornar erros. Encerramento abrupto pode deixar um passo
marcado como incompleto: /undo recusa restauração automática sem estado posterior
confiável. Evite outro processo modificando a árvore durante uma operação.
/undo não desfaz commits, chamadas web ou ações temporárias de containers.

A limpeza de sessões inativas após dez dias também remove seus checkpoints e
permissões em memória, na inicialização e no ciclo horário de retenção. Sessões
renovadas e mensagens recentes continuam protegidas pela consulta de retenção.
Não há mudança de schema Prisma nem necessidade de migrations para checkpoints.
