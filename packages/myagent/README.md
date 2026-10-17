# My-Code-Agent

Assistente de programação no terminal, com servidor local e SQLite embutidos.
Requer **Bun >= 1.3.13 no PATH**, inclusive ao instalar com npm.
Não requer PostgreSQL nem dois terminais.

```sh
npm i -g my-code-agent
cd meu-projeto
myagent
```

| Comando | Uso |
| --- | --- |
| `myagent` | Retoma a sessão mais recente da pasta ou cria a primeira |
| `myagent --new` | Cria outra sessão |
| `myagent resume` | Escolhe uma sessão da pasta |
| `myagent resume --all` | Lista sessões de todas as pastas |
| `myagent doctor` | Verifica Bun, diretório de dados, SQLite e Docker |
| `myagent --help` | Ajuda |
| `myagent --version` | Versão sem abrir banco ou servidor |

Use `/models` para selecionar/configurar um modelo e `/agents` ou Tab para
alternar PLAN/BUILD. Durante a geração, a indicação de execução mantém o modo
da chamada; a barra de entrada mostra o modo da próxima mensagem.
Ctrl+C encerra o aplicativo e libera o lock da sessão. Outra execução da mesma
sessão é recusada; `--new` permite uma sessão independente na mesma pasta.

Os dados ficam em `~/.myagent/`, com override por `MYAGENT_HOME`: banco
`myagent.db`, chaves em `config.env`, modelos em `models.json` e preferências.
As migrations SQLite são aplicadas automaticamente pelo aplicativo instalado;
não execute `db.generate`, `db.deploy`, `db.push` ou o Prisma CLI nessa instalação.
Esses comandos de geração/deploy pertencem ao desenvolvimento no monorepo.
Não há importação automática de dados antigos do PostgreSQL.

Configure as chaves cloud pelo diálogo `/models`, que as salva no diretório
global, ou pelas variáveis indicadas por `myagent doctor`. Variáveis já presentes
no ambiente têm precedência. Não compartilhe o conteúdo do diretório global.
Para Ollama, selecione ou adicione o identificador local em `/models` e use
`OLLAMA_BASE_URL` (padrão `http://localhost:11434/v1`) e, se necessário,
`OLLAMA_API_KEY`. Ter Ollama configurado não baixa nem inicia um modelo.

Docker é opcional para abrir a CUI e conversar. Sem daemon ativo, a interface
avisa e omite `bash`, `type_check` e `test_run`. Os comandos do modelo executam
somente em Docker, sem fallback no host, sem rede e com snapshot somente leitura.
A imagem padrão é `oven/bun:1.3.13`; `MYAGENT_SANDBOX_IMAGE` permite outra imagem
de confiança com as ferramentas e dependências necessárias. O pull só acontece
após aprovação da ferramenta. A imagem padrão não inclui automaticamente as
dependências de seu projeto.

No Windows, o npm cria `myagent.cmd`. Mantenha Bun e o diretório global do npm
no PATH. Se PowerShell bloquear `npm.ps1`, use `npm.cmd`.
OpenTUI e libsql instalam binários nativos por plataforma; preserve as dependências
opcionais (não use `--omit=optional`). Uma plataforma sem binário compatível não
é suportada; reinstalar não cria suporte a ela.

A validação desta preparação foi feita em Windows com Bun 1.3.13 e IA simulada
localmente, sem chamadas pagas. Linux/macOS, Docker real e modelos reais não foram
validados nesta preparação. Testes simulados não garantem compatibilidade com
qualquer modelo, imagem Docker ou plataforma. O código-fonte precisa de Bun;
não há target Node nem executável compilado independente.
