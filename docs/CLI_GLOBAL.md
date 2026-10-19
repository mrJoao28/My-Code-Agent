# CLI global com Bun e SQLite

O pacote é `@j2008/my-code-agent` e instala o comando `myagent`.
A versão publicada vem de `packages/myagent/package.json`.
O agente executa com Bun >= 1.3.13. A entrada global usa Node.js >= 22 e npm;
o npm não instala o runtime Bun.

## Uso

Com o pacote disponível no npm:

```sh
npm i -g @j2008/my-code-agent
cd caminho/do/projeto
myagent
```

`myagent` retoma a sessão mais recente do workspace; `--new` cria outra.
`myagent resume` lista as sessões da pasta com opção de ver todas. Ao selecionar
uma sessão de outra pasta, o launcher valida aquela pasta e inicia o servidor
autorizando somente o workspace escolhido. `resume --all` abre diretamente essa
lista completa. A seleção requer terminal interativo.

`--help` e `--version` funcionam sem abrir banco, servidor ou CUI.
`doctor` verifica Bun, escrita no diretório global, abertura e migrations do
SQLite, Docker, imagem e presença das variáveis de chave por modelo. Os valores
das chaves nunca são exibidos. Docker ausente é uma capacidade opcional; falhas
no banco/diretório global ou Bun incompatível produzem código de saída não zero.

## Workspace e isolamento

A raiz é obtida com `git rev-parse --show-toplevel`; sem Git/repositório, usa-se
a pasta atual. Os caminhos passam por realpath e pela proteção de arquivos.
Symlinks/junctions e ancestrais inexistentes são recusados. No Windows, a chave
da pasta fica em minúsculas; o título mantém o caminho absoluto exibível.

O servidor usa token aleatório por execução, loopback, porta livre e apenas um
workspace autorizado. Todas as rotas continuam protegidas contra navegador e
acesso sem token. A listagem da CUI filtra pela pasta atual. Carregamento e chat
conferem proprietário local e workspace, além do id da sessão.

Os locks de sessão ficam no SQLite, têm proprietário aleatório, heartbeat a cada
5 segundos e timeout de 30 segundos. Outro processo recebe a mensagem de pasta
aberta em outro terminal. Após falha abrupta, o lock pode ser recuperado depois
do timeout. `--new` permite outra sessão na mesma pasta. Encerramento normal
cancela gerações e libera servidor, timer de limpeza, locks e banco.

## Diretório global

O padrão é `~/.myagent/`; `MYAGENT_HOME` aceita um caminho alternativo absoluto
ou relativo, resolvido na inicialização. `MYAGENT_CONFIG_DIR` continua como alias
antigo quando `MYAGENT_HOME` não estiver definido.

O SQLite fica em `myagent.db`. WAL, busy timeout de 5000 ms e foreign keys são
ativados na abertura. As migrations SQL são importadas como texto no bundle,
executadas numa transação e registradas em `PRAGMA user_version`. Falhas
revertem toda a sequência pendente. Não há dependência do Prisma CLI no app
instalado, nem db.push, reset ou importação automática de dados do PostgreSQL.

Chaves e Ollama são salvos em `config.env`; modelos personalizados, em
`models.json`; tema, em `preferences.json`. Credenciais ChatGPT continuam em
arquivo privado próprio. Não copie o diretório global para repositórios.
Variáveis já presentes no ambiente têm precedência. A API de desenvolvimento
continua usando token privado persistido, e o launcher entrega seu token
diretamente à CUI sem gravá-lo.

## Docker e imagem

A inicialização consulta `docker info` com timeout de três segundos e
cancelamento. Sem daemon/CLI, o app continua disponível e omite bash,
type_check e test_run da lista real de ferramentas. PLAN continua sem mutações.

A imagem padrão é `oven/bun:1.3.13`; altere `MYAGENT_SANDBOX_IMAGE` para uma
imagem de confiança com compiladores e dependências do projeto. O pull acontece
na primeira execução que precisar dela. Comandos isolados dispensam aprovação;
bash continua indisponível em PLAN. Uma falha de
rede é explicada sem executar comandos no host. A imagem padrão contém Bun;
ela não contém automaticamente as dependências de cada projeto nem tsc.

O container executa sem rede, com root filesystem somente leitura, usuário não
root, limites de recursos e `/tmp` descartável. O snapshot ignora credenciais,
Git, node_modules e diretórios de build; arquivos acima de 5 MiB são omitidos.
O limite total é 200 MiB e 20 mil entradas, conferido durante a leitura. As
proteções do host não eliminam corridas com outro processo trocando arquivos.

## Build e instalação local

Na raiz:

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
cd packages/myagent
npm pack
```

O build usa target Bun, inclui os pacotes do monorepo, migrations e workers de
grep/análise. Libsql, adapter/Prisma runtime, OpenTUI e React são dependências
externas declaradas. O manifest publicável não contém referências workspace.
O cliente Prisma continua gerado e ignorado pelo Git.

Na verificação inicial, Prisma, cliente e adapter estavam na versão 7.4.0.
Essa versão suporta enum/Json em SQLite, não exige o preview driverAdapters e
usa engine de cliente. O export instalado é PrismaLibSql. A baseline foi gerada
com `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`:
no Prisma 7, --to-schema substitui o antigo --to-schema-datamodel.

Para testar em uma pasta temporária com espaços no Windows, ajuste caminhos:

```powershell
npm i -g --prefix 'C:/temp/myagent install' --package-lock=false ./j2008-my-code-agent-0.1.1.tgz
$env:MYAGENT_HOME='C:/temp/myagent home'
Set-Location 'C:/temp/projeto com espaços'
& 'C:/temp/myagent install/myagent.cmd' --version
& 'C:/temp/myagent install/myagent.cmd' doctor
& 'C:/temp/myagent install/myagent.cmd'
```

No POSIX, o executável fica em `<prefix>/bin/myagent`. Bun precisa estar no
PATH. O bin `bin/myagent.js` tem shebang Node (requer >= 22), procura Bun e
executa `dist/cli.js`, herdando terminal, argumentos e código de saída. Sem Bun,
termina com código 1 e informa https://bun.sh. No Windows, o shim `.cmd` do npm
inicia essa entrada Node. O bundle continua target Bun, sem `bun build --compile`.

## CI e publicação por tag

`bun run build` gera os três bundles. `pwsh -File scripts/package-smoke.ps1`
empacota sem repetir o build, confere a lista exata de seis arquivos (manifest,
README, entrada Node e três bundles), instala com npm global sem Bun no PATH em
prefixo temporário com espaços e usa `MYAGENT_HOME` temporário. Fora do workspace, verifica versão,
`doctor` e a mensagem sem Bun no PATH. O script limpa só seu diretório temporário.
O job `package` executa esse fluxo em Ubuntu e Windows.

O workflow `release.yml` aceita tags `v*`, exige igualdade exata entre tag
`v<versão>` e versão do pacote, instala com `bun install --frozen-lockfile`,
compila, verifica tipos/testes/instalação e executa
`npm publish --provenance --access public`. Usa `id-token: write`, Node 24 e
OIDC. Antes da primeira tag, cadastre no npm um Trusted Publisher GitHub Actions:
owner `mrJoao28`, repositório `My-Code-Agent`, arquivo `release.yml`, permitindo
`npm publish`. O pacote precisa existir para cadastrar o publisher; se necessário,
a primeira publicação é manual. Não crie tags de release sem querer publicar.
Veja [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).

`.github/dependabot.yml` agenda revisões semanais de Bun e GitHub Actions.
Essa configuração não ativa sozinha os alertas: no GitHub, abra Settings →
Advanced Security → Dependabot alerts → Enable. Ative também security updates
se desejar PRs corretivos. É necessário acesso de administrador; veja a
[configuração oficial dos alertas](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts).
O CI executa `bun audit` como aviso; falhas de consulta e vulnerabilidades ficam
visíveis no log, sem bloquear os demais checks.

## Publicação manual

Depois de revisar o conteúdo de `npm pack --dry-run`, validar a instalação do
tarball e conferir a versão:

```sh
cd packages/myagent
npm login
npm publish --access public
```

Não publique o workspace inteiro nem inclua configurações/chaves. As migrations
PostgreSQL antigas ficam somente no repositório, fora do runner e do pacote.

## Validação registrada em 16/10/2026

Ambiente local: Windows, Bun 1.3.13. Antes das alterações, instalação com
lockfile congelado e typecheck passaram; a suíte tinha 259 aprovados e 6
ignorados, sem falhas. Ao final, `bun test` teve 278 aprovados, 2 ignorados e
nenhuma falha. O typecheck dos cinco pacotes e o build passaram separadamente.

O `npm pack` gerou um tarball de aproximadamente 2 MB, com README, manifest,
CLI e dois workers. O manifest não contém workspace:*; as migrations estão no
JavaScript. O tarball foi instalado com npm global em prefixo temporário
isolado, com espaços no caminho. Fora do repositório, o shim myagent.cmd passou
em --version e doctor, abrindo/migrando um home temporário sem PostgreSQL.
Os workers de grep e análise também executaram fora do repositório.

A CUI instalada abriu o workspace temporário, exibiu seu caminho e o aviso de
Docker ausente. Um segundo processo foi recusado pela mesma sessão. Após
Ctrl+C, uma consulta ao banco confirmou zero locks e a chave do workspace em
minúsculas. As cinco migrations/arquivos legados foram comparados ao conteúdo
original, normalizando somente CRLF/LF, sem mudanças no SQL.

As restrições da sandbox bloquearam cache npm/temporários e inspeção dos
ancestrais do perfil; as verificações correspondentes passaram com execução
autorizada fora dela. Docker real não estava disponível: os dois testes de
container foram ignorados, não aprovados. Pull e detecção de Docker foram
validados com mocks. Não houve chamadas pagas a providers, teste local em
Linux/macOS, publicação npm, commit ou push.

## Revisão de publicação — 17/10/2026

Consulte [PREPARACAO_PUBLICACAO_NPM.md](PREPARACAO_PUBLICACAO_NPM.md) para o diagnóstico,
correções, saídas verificadas, limitações e checklist manual atualizados.
