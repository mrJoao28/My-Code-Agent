# My-Code-Agent

Assistente de programação no terminal, com Bun, React/OpenTUI, Hono, AI SDK e Prisma/SQLite local. O comando `myagent` abre o agente na pasta atual e retoma a sessão mais recente daquele workspace.

## Automação sem interface

```sh
myagent exec "Leia README.md e resuma o projeto"
myagent exec "Corrija o bug descrito" --mode build --model gpt-5.4 --approve all
myagent exec "Leia src/index.ts" --json --approve none
```

`exec` usa uma sessão nova e mantém autenticação privada, workspace, locks,
persistência e checkpoints. O padrão é `--mode plan --approve none`: leituras
locais são permitidas; comandos, escritas e rede são negados. `--approve reads`
também autoriza `web_search` e `web_fetch`. `--approve all` autoriza cada ação
da execução, inclusive escritas, exclusões e commits; use somente quando isso
for desejado. PLAN continua sem ferramentas de escrita e comandos continuam
exclusivos do Docker. Não há fallback para execução no host.

Mensagens aceitam até **9.000 caracteres**, na CUI, na API e em `exec`.
Push exige também `--allow-push`, junto de `--mode build --approve all`.
A flag só permite branches de trabalho; `main`/`master` precisam da confirmação
adicional na CUI e são recusadas pelo modo não interativo.

## Fluxo Git com aprovação

Em BUILD, `git_init` inicializa com `main` somente fora de outro repositório;
`git_switch` cria ou troca de branch sem force/delete; `git_remote_add` adiciona
uma URL HTTPS sem credenciais. O host permitido por padrão é `github.com`;
configure `MYAGENT_GIT_ALLOWED_HOSTS=github.com,git.exemplo.com` no ambiente ou em
`~/.myagent/config.env` para permitir outros hosts exatos (sem curingas).

`git_commit` respeita a identidade local, ou lê somente `user.name` e `user.email`
globais para passá-los ao comando. Se faltarem, configure `git config --global
user.name "Seu nome"` e `git config --global user.email "voce@exemplo.com"`.
O restante da configuração global permanece desabilitado nas operações Git.

`git_push` mostra URL completa e branch e exige aprovação em cada chamada; init
e remote_add também nunca permitem autorização por sessão. Em `main`/`master`,
Y abre uma segunda confirmação e M autoriza explicitamente o envio. Não há force,
delete, mirror ou push de tags. O transporte usa HTTPS e os credential helpers
de sistema/global já instalados, sem prompt interativo, com hooks desligados e
timeout de 60 segundos. Configure o acesso Git fora do agente se necessário;
não coloque tokens na URL. Rewrites, proxies, headers e helpers locais do
repositório são recusados para impedir mudança silenciosa de destino/credenciais.

Após um push bem-sucedido, a geração termina informando a branch e aguardando que
você libere o PR no GitHub e avise para continuar. Não cria PR nem inicia outra
branch automaticamente. Após seu aviso, troque para a principal e aprove
`git_sync`: fetch seguido de merge `--ff-only`, com workspace/staging limpos;
divergências são reportadas sem resolução automática. Em pasta vazia, os arquivos
pedidos são criados antes do primeiro commit. Não há commits automáticos.

Sem `--json`, a resposta final vai para stdout e erros para stderr. Com `--json`,
stdout contém eventos JSONL do streaming e um último evento `exec-result`, com
texto final, status, sessão, modelo, tokens, chamadas e duração. Fechar a conexão
sem evento `done` é falha. Códigos de saída: **0** sucesso, **1** falha,
**3** aprovação negada e **130** cancelamento. Qualquer negação mantém a saída 3,
mesmo quando o modelo conclui uma explicação. Nenhum modo abre a CUI ou solicita
resposta interativa para aprovações.

Para medir qualidade com chamadas reais e pagas, execute
`bun run eval --model gpt-5.4 --model gpt-5.4-mini` no checkout. As nove
tarefas e os limites da comparação estão em [evals/README.md](evals/README.md).
As avaliações não rodam no CI padrão.
`bun run eval --simulate` valida o pipeline sem consumo de tokens ou inferência;
os perfis e tokens são fictícios e o relatório identifica a simulação.

## Instalação

A instalação global usa **Node.js >= 22 e npm**. O agente executa com
**Bun >= 1.3.13** no PATH; o npm não instala Bun. Siga [bun.sh](https://bun.sh)
ou use o comando correspondente ao seu sistema:

```sh
# Linux/macOS
curl -fsSL https://bun.sh/install | bash
```

```powershell
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Abra um novo terminal e confirme `bun --version`. Depois:

```sh
npm i -g @j2008/my-code-agent
cd meu-projeto
myagent
```

O comando de entrada usa Node e procura Bun no PATH. Se Bun faltar, explica como instalar e termina com código 1. No Windows, o npm cria o shim `myagent.cmd`; se PowerShell bloquear `npm.ps1`, use `npm.cmd`. A pasta de executáveis globais do npm precisa estar no PATH. Preserve as dependências opcionais: OpenTUI e libsql usam binários específicos da plataforma.

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

## Janela de contexto e ferramentas

A janela é resolvida por uma única política: override por modelo, catálogo,
snapshot datado de uma família conhecida e, por fim, padrão conservador.
Modelos cloud sem metadados usam **65.536 tokens estimados**, sem garantia de que
essa seja a capacidade real. Ollama e modelos customizados usam 16.384 por padrão.
O seletor mostra o tamanho e marca valores fora do catálogo como **estimados**.

Para configurar qualquer modelo, inclusive IDs `chatgpt:`, crie
`~/.myagent/model-preferences.json` (ou dentro de `MYAGENT_HOME`). Exemplo
ilustrativo: substitua a janela pela capacidade verificada para sua conta/modelo.

```json
{
  "contextWindows": { "chatgpt:gpt-5.6-luna": 131072 },
  "defaultLocalContextWindow": 16384
}
```

O override em preferências prevalece sobre `contextWindow` em `models.json`.
Valores devem ser inteiros entre 1.024 e 2.147.483.647; arquivo inválido produz
erro claro e é preservado. No POSIX, proteja o arquivo com modo `0600`.
O padrão local configurável vale para modelos customizados sem janela explícita
e modelos locais fora do catálogo; não substitui capacidades do catálogo.

Abaixo de 32.768 tokens, o perfil compacto expõe somente leitura, busca, edição,
escrita e Git básico; bash só aparece em BUILD com sandbox disponível. PLAN
continua sem mutações. A interface e o histórico registram o aviso de redução.
O custo das ferramentas usa nome, descrição, JSON Schema e opções do provider,
com cache por conjunto; não serializa internals do Zod. System prompt e schemas
são descontados do orçamento, com reserva para a resposta. Se nem o perfil
compacto couber, o erro informa janela, quantidade de ferramentas e custo
estimado, e orienta configurar `contextWindow` ou escolher outro modelo.

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

**O login ChatGPT fica ativado por padrão.** Use “Continuar com ChatGPT / gerenciar
contas” para conectar sua conta; a disponibilidade da opção não faz login sozinha.
Para desativar, defina `MYAGENT_ENABLE_CHATGPT=0` no ambiente ou em
`~/.myagent/config.env` e reinicie o aplicativo. Quando a variável está definida,
somente o valor `1` habilita o login. Com o login desativado, o servidor bloqueia
login, descoberta de modelos e uso de credenciais ChatGPT já salvas.

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
Definir `MYAGENT_ENABLE_CHATGPT=0` impede o uso, mas não apaga nem revoga credenciais já salvas.
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

## Limites conhecidos

O runtime do agente continua sendo Bun; a entrada Node apenas verifica e inicia
esse runtime. Não há executável independente. As verificações de instalação no CI
cobrem Linux e Windows; macOS não tem esse job. OpenTUI/libsql exigem binários
compatíveis com a plataforma e um terminal interativo para a CUI. `--version` e
`doctor` funcionam sem terminal interativo ou chave de IA; `doctor` cria/migra o
SQLite no diretório global configurado.

A sandbox não instala dependências pela rede e dependências nativas copiadas do
Windows podem não funcionar no container Linux. Uma falha abrupta durante uma
escrita pode deixar o resultado desconhecido; confira o arquivo antes de repetir
a ação. O contexto enviado ao modelo pode ser resumido/abreviado, embora os
resultados completos permaneçam no histórico local. Chamadas reais a provedores
podem ter custo e dependem das condições do serviço.

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

O CI instala o tarball em diretório temporário no Linux/Windows e verifica o
conteúdo publicável, `--version`, `doctor` e Bun ausente. `bun audit` roda como
aviso, sem bloquear o CI. O Dependabot acompanha Bun e GitHub Actions; os alertas
de segurança precisam estar habilitados nas configurações do repositório.

A publicação é acionada por tag `v<versão>` igual à versão de
`packages/myagent/package.json`, com OIDC e provenance. Configure previamente o
Trusted Publisher npm para `mrJoao28/My-Code-Agent`, workflow `release.yml`.
Nenhum token npm de longa duração é necessário nesse fluxo. Veja a
[documentação npm sobre Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).

Consulte [instalação, empacotamento e publicação](docs/CLI_GLOBAL.md), [segurança e testes](docs/SEGURANCA_E_TESTES.md) e [análise técnica](docs/ANALISE_PROJETO.md).
