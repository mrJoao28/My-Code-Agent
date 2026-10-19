# My-Code-Agent

Assistente de programação no terminal, com servidor local e SQLite embutidos.
A instalação usa **Node.js >= 22 e npm**. O agente requer **Bun >= 1.3.13
no PATH**, inclusive ao instalar com npm. Instale em [bun.sh](https://bun.sh):

```sh
# Linux/macOS
curl -fsSL https://bun.sh/install | bash
```

```powershell
# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

Abra outro terminal e confirme `bun --version`. A entrada Node mostra como
instalar Bun se ele estiver ausente; não instala o runtime automaticamente.
Não requer PostgreSQL nem dois terminais.

```sh
npm i -g @j2008/my-code-agent
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
| `myagent exec "prompt"` | Executa sem interface, em uma sessão nova |
| `myagent --help` | Ajuda |
| `myagent --version` | Versão sem abrir banco ou servidor |

`exec` aceita `--mode plan|build`, `--model ID`, `--json` e
`--approve none|reads|all`. O padrão PLAN/none permite leituras locais e nega
escritas, rede e comandos. `reads` também permite busca e leitura web; `all`
autoriza ações desta execução, inclusive escritas, exclusões e commits. PLAN
continua sem escrita e comandos sempre exigem Docker. A resposta final vai para
stdout; `--json` usa eventos JSONL e termina com `exec-result`. Códigos: 0 sucesso,
1 falha, 3 aprovação negada e 130 cancelamento. Não solicita interação na CUI.

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
de confiança com as ferramentas e dependências necessárias. O pull acontece na primeira execução que precisar da imagem. Esses comandos
isolados dispensam aprovação na CUI; em `exec` exigem `--approve all`.
Mensagens permitem até 9.000 caracteres. Ferramentas Git em BUILD incluem init,
criação/troca de branch, remote HTTPS, commit, push e sync `--ff-only`, com aprovação.
Push, init e remote_add não permitem aprovação por sessão; main/master exigem Y
seguido de M na CUI. `exec --approve all` só permite push de branches de trabalho
com a flag adicional `--allow-push`. Após enviar uma branch, o agente para e espera
que você libere o PR no GitHub e avise para continuar. Veja o README da raiz para
identidade Git, credential helpers e `MYAGENT_GIT_ALLOWED_HOSTS`.
Bash fica disponível só em BUILD. A imagem padrão
não inclui automaticamente as dependências de seu projeto. Para copiar
`node_modules`/`.venv` já instalados, use `MYAGENT_SANDBOX_DEPENDENCIES=1`;
eles permanecem somente leitura, filtrados e precisam ser compatíveis com Linux.
`MYAGENT_SANDBOX_TMPFS_MIB` ajusta `/tmp` (64 MiB por padrão).

No Windows, o npm cria `myagent.cmd`. Mantenha Bun e o diretório global do npm
no PATH. Se PowerShell bloquear `npm.ps1`, use `npm.cmd`.
OpenTUI e libsql instalam binários nativos por plataforma; preserve as dependências
opcionais (não use `--omit=optional`). Uma plataforma sem binário compatível não
é suportada; reinstalar não cria suporte a ela.

## Segurança, privacidade e limites

PLAN não altera arquivos do projeto. BUILD pede aprovação para escritas e rede;
Y permite uma vez, A permite na sessão e no escopo exibido, N nega. Exclusões e
commits sempre pedem aprovação individual. `/undo` restaura o último passo de
arquivo se não houver conflito, a partir de checkpoints locais, sem commits.

O provedor selecionado recebe pedidos, instruções AGENTS.md, histórico que couber
no contexto e resultados de ferramentas: arquivos lidos, diffs, caminhos e saídas.
Não envie segredos. Ollama só mantém esse tráfego local se o endpoint configurado
for local. Tavily recebe consultas de busca; sites consultados recebem URL e IP
de origem. Chaves são mascaradas na CUI, mas salvas sem criptografia própria no
perfil do usuário; no POSIX os arquivos privados usam modo 0600, no Windows
proteja o diretório pelas ACLs.

O login ChatGPT fica **ativado por padrão**. Use “Continuar com ChatGPT / gerenciar
contas” para iniciar o fluxo OAuth no navegador; os tokens ficam no diretório global.
Para desativar, defina `MYAGENT_ENABLE_CHATGPT=0` e reinicie o aplicativo.
Essa integração pode depender de plano/permissões e mudar com o provedor.
Consulte [dados enviados e login ChatGPT](https://github.com/mrJoao28/My-Code-Agent#dados-enviados-e-login-chatgpt)
antes de conectar sua conta ou enviar código privado.

Gerações interrompidas são mostradas ao reabrir e a CUI pergunta antes de retomar
ou gastar tokens. Um efeito iniciado pode ter desfecho desconhecido: inspecione
antes de repetir. Sessões inativas têm retenção de 90 dias com aviso prévio;
`MYAGENT_SESSION_RETENTION_DAYS=0` desliga a exclusão automática.

O CI verifica instalação no Linux e Windows; macOS não tem essa verificação.
A CUI exige terminal interativo e binários OpenTUI/libsql compatíveis. Não há
executável independente de Bun. A sandbox não instala dependências pela rede;
dependências nativas precisam corresponder ao Linux da imagem. Provedores podem
cobrar pelo uso; os testes do projeto usam IA simulada, sem chamadas pagas.
