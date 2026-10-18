# My-Code-Agent

Assistente de programação no terminal, com Bun, React/OpenTUI, Hono, AI SDK e Prisma/SQLite local. O comando `myagent` abre o agente na pasta atual e retoma a sessão mais recente daquele workspace.

## Instalação

Requer **Bun >= 1.3.13** disponível no PATH. Instale o Bun seguindo https://bun.sh.

Após a publicação do pacote no npm:

```sh
npm i -g @j2008/my-code-agent
cd meu-projeto
myagent
```

O pacote usa `#!/usr/bin/env bun`; npm instala o comando, mas não instala o runtime Bun. No Windows, o npm cria o shim `myagent.cmd`. A pasta de executáveis globais do npm precisa estar no PATH.

**Docker é opcional para abrir o aplicativo.** Sem Docker ativo, a interface avisa que os comandos estão desativados. Shell, typecheck e execução de testes exigem Docker e sandbox, sem aprovação por chamada. Shell continua indisponível em PLAN; alterações no projeto e rede exigem aprovação. Não existe fallback no host.

## Comandos

| Comando | Comportamento |
| --- | --- |
| `myagent` | Retoma a última sessão da pasta ou cria uma |
| `myagent --new` | Cria outra sessão na mesma pasta |
| `myagent resume` | Escolhe uma sessão da pasta; permite listar todas |
| `myagent resume --all` | Lista sessões de todas as pastas para escolha |
| `myagent doctor` | Verifica Bun, diretório global, SQLite, Docker, imagem, ferramentas do projeto e nomes das chaves necessárias |
| `myagent --version` | Exibe a versão |
| `myagent --help` | Exibe a ajuda |

Dentro de um repositório Git, o workspace é sua raiz, mesmo ao abrir uma subpasta. Fora de Git, é a pasta atual. O caminho canônico identifica o workspace; no Windows, a chave fica em minúsculas. O título exibido é o caminho absoluto. Links/junctions são recusados.

Sessões da mesma pasta podem coexistir. A mesma sessão não pode ser usada por dois processos: um lock no SQLite tem heartbeat a cada 5 segundos e expira em 30 segundos se o processo parar. As gerações são gravadas incrementalmente no SQLite: texto, chamadas antes da execução e resultados completos. Ao reabrir, gerações órfãs aparecem como interrompidas e a CUI pergunta **“Retomar a geração pendente?”** antes de usar tokens. A retomada recupera as ferramentas registradas e bloqueia a repetição automática de efeitos já iniciados. Se o processo caiu durante um efeito, o resultado pode ser desconhecido: inspecione o estado antes de pedir outra ação.

A retenção padrão é de **90 dias** de inatividade, configurável por `MYAGENT_SESSION_RETENTION_DAYS`; use `0` para nunca apagar. O aviso aparece nos logs e na lista de sessões, com pelo menos **24 horas** antes da exclusão. Abrir a sessão cancela o aviso e renova o prazo. Sessões com geração em andamento ou lease ativo ficam protegidas. A exclusão também limpa os checkpoints associados; exporte o histórico antes do prazo se precisar conservá-lo.

## Configuração e dados locais

Tudo fica em `~/.myagent/`, com override por `MYAGENT_HOME`:

- `myagent.db`: banco SQLite local, com WAL, migrations automáticas e histórico de mensagens/parts.
- `config.env`: chaves e configuração do Ollama salvas pela interface; não compartilhe esse arquivo.
- `models.json`: modelos personalizados.
- `preferences.json`: tema da interface.
- `chatgpt-credentials.json`: credenciais da conta conectada, quando utilizada.
- `api-token`: token persistido somente no modo de desenvolvimento; o launcher usa um token aleatório em memória por execução.

`DATABASE_URL` e PostgreSQL não são necessários. Variáveis do ambiente têm precedência sobre `config.env`. Consulte `.env.example` para nomes públicos; nunca versione chaves. No Windows, proteja o diretório global pelas ACLs do perfil do usuário.

A imagem padrão da sandbox é `oven/bun:1.3.13`, configurável por `MYAGENT_SANDBOX_IMAGE`. O aplicativo faz pull somente na primeira execução que precisar da imagem. Ela contém Bun; compiladores e dependências específicos do projeto podem exigir uma imagem personalizada. O container roda sem rede, com snapshot filtrado somente leitura reaproveitado por sessão e arquivos temporários em `/tmp`.

Para usar dependências já instaladas, defina `MYAGENT_SANDBOX_DEPENDENCIES=1` no ambiente. A cópia filtrada de `node_modules` e `.venv` permanece somente leitura e tem limite padrão de 512 MiB, ajustável por `MYAGENT_SANDBOX_DEPENDENCY_MIB`. Links externos são omitidos e dependências precisam ser compatíveis com Linux. `MYAGENT_SANDBOX_TMPFS_MIB` ajusta o espaço temporário (padrão 64 MiB). Veja [segurança e testes](docs/SEGURANCA_E_TESTES.md) para os limites e o tratamento de `.bin`.

Durante uma aprovação, Y permite uma vez, A permite na sessão e no escopo
exibido e N nega. Exclusão e commit sempre pedem aprovação individual. O comando
`/undo` restaura o último passo de arquivo quando não há mudanças posteriores;
os checkpoints ficam no diretório global, sem commits no projeto. Veja
[aprovações e desfazer](docs/APROVACOES_E_UNDO.md).

## Dados enviados e login ChatGPT

O agente envia ao **provedor do modelo selecionado** o pedido, o system prompt,
as instruções `AGENTS.md`, o histórico que couber na janela de contexto, os schemas
das ferramentas e seus resultados (incluindo conteúdo de arquivos, diffs, caminhos,
saídas de comandos e páginas consultadas). Isso pode incluir dados privados do
projeto. A aplicação não envia o workspace inteiro automaticamente; qualquer
conteúdo lido por uma ferramenta pode entrar nas próximas requisições ao modelo.
Não coloque segredos nos pedidos, instruções ou arquivos que o agente vai ler.

| Destino | O que recebe |
| --- | --- |
| Anthropic, OpenAI ou Google por API key | Contexto descrito acima, identificador do modelo e a chave desse provedor para autenticação. As outras chaves locais não são anexadas ao contexto. |
| Ollama | O mesmo contexto no `OLLAMA_BASE_URL` configurado, com `OLLAMA_API_KEY` se definida. É local apenas se esse endereço apontar para seu computador; um endpoint remoto recebe o código. |
| OpenAI com login ChatGPT | Contexto e ferramentas em `https://api.openai.com/v1/responses`, autenticados por token OAuth da conta ativa. A requisição usa `store: false`, o que não constitui promessa de retenção zero ou dispensa das políticas do serviço. |
| Tavily (`web_search`) | A consulta produzida pelo modelo e a chave Tavily; a consulta pode conter trechos do projeto. |
| Site consultado (`web_fetch`) | URL completa, caminho/query, cabeçalhos HTTP e IP de origem da conexão. Fragmentos de URL não são enviados em HTTP. O site não recebe as chaves dos modelos nem o histórico inteiro. |

`web_fetch` aceita somente destinos públicos: resolve o DNS uma vez por destino,
recusa respostas com qualquer IP interno/reservado e conecta ao IP validado,
preservando Host e verificação TLS/SNI. Cada redirect é validado novamente.
Redirect para outro domínio exige nova chamada quando a aprovação vale por domínio.
Não usa cookies do navegador, proxy do ambiente nem credenciais embutidas na URL.

**O login ChatGPT fica desligado por padrão.** Para habilitar, defina
`MYAGENT_ENABLE_CHATGPT=1` no ambiente ou em `~/.myagent/config.env` e reinicie o
aplicativo. Outras configurações desse valor não habilitam o login. Depois use
“Continuar com ChatGPT / gerenciar contas”; habilitar a variável não faz login
sozinho. Sem a opção, o servidor bloqueia login, descoberta de modelos e uso de
credenciais ChatGPT já salvas.

O fluxo implementado neste projeto abre o navegador em `auth.openai.com`, solicita
autorização OAuth com PKCE (`S256`), state e nonce, e recebe o código em um callback
loopback temporário. Solicita identidade/perfil/email, acesso offline e permissões
`resource.invoke` e `chatgpt.tokens.use.direct`. Troca o código por tokens e pode
renová-los para continuar usando a conta. A senha é digitada no site de autenticação,
nunca na CUI. Identificadores da conta, catálogo e tokens de acesso/renovação/identidade
ficam em `chatgpt-credentials.json`, sem criptografia própria; no POSIX há proteção
por modo `0600` e no Windows a proteção depende das ACLs do perfil.

Esses tokens permitem agir com as permissões concedidas: proteja também cópias de
segurança do diretório global. Desconectar apaga os tokens locais e tenta a revogação
remota quando a integração está habilitada; uma falha de revogação é informada.
Desabilitar a variável impede o uso, mas não apaga nem revoga credenciais já salvas.
O fluxo é uma implementação deste aplicativo, não uma garantia de compatibilidade
com todo plano/conta; endpoints, permissões, limites e elegibilidade podem mudar.
Confira a autorização no navegador e os controles da conta antes de enviar código.
Consulte a [documentação oficial de autenticação](https://developers.openai.com/codex/auth)
e os [controles de dados da API OpenAI](https://developers.openai.com/api/docs/guides/your-data);
as condições aplicáveis dependem do serviço e da conta, não apenas de `store: false`.

`config.env` e `models.json` são gravados por temporário no mesmo diretório e troca
atômica, com modo `0600` no POSIX; permissões abertas são ajustadas antes da leitura.
As chaves ficam mascaradas durante a digitação/colagem na CUI. A máscara não cifra
os arquivos. `models.json` precisa ser JSON válido e passar pelo schema de modelos;
em caso de corrupção o aplicativo informa o erro e preserva o arquivo para correção,
em vez de assumir um catálogo vazio.

## Desenvolvimento

Use o workspace da raiz e Bun:

```sh
bun install --frozen-lockfile
bun run --cwd packages/database db.generate
bun test
bun run typecheck
bun run build
```

Os comandos anteriores continuam disponíveis em terminais separados:

```sh
bun run dev:server
bun run dev:cli
```

O servidor de desenvolvimento usa loopback e porta 3000. A CUI aceita `API_URL`. `bun run --cwd packages/database db.migrate` abre e atualiza somente o SQLite local; não usa Prisma CLI em runtime nem recria o banco.

## Arquitetura e segurança

- `packages/myagent`: launcher e pacote npm `@j2008/my-code-agent`, comando `myagent`.
- `packages/cui`: interface, foco, diálogos, aprovação e streaming SSE.
- `packages/server`: API privada, providers, ferramentas e ciclo de geração.
- `packages/shared`: modelos e contratos de mensagens/eventos.
- `packages/database`: Prisma 7.4.0, libsql, migrations embutidas e abertura local.

PLAN continua sem ferramentas que alterem o código. BUILD exige aprovação para alterações e rede; processos só executam na sandbox Docker. Uma tarefa comum não cria documentação automaticamente. A API recusa clientes de navegador, exige token privado e valida o workspace da sessão antes de carregá-la ou continuar uma geração.

As migrations antigas do PostgreSQL estão arquivadas em `packages/database/prisma/migrations-postgres-legacy/`. Dados antigos do PostgreSQL **não são importados**; bancos e volumes existentes não são apagados.

Consulte [instalação, empacotamento e publicação](docs/CLI_GLOBAL.md), [segurança e testes](docs/SEGURANCA_E_TESTES.md) e [análise técnica](docs/ANALISE_PROJETO.md).
