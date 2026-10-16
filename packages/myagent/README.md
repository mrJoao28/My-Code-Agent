# My-Code-Agent

Assistente de programação no terminal. Requer **Bun >= 1.3.13** no PATH.

```sh
npm i -g my-code-agent
cd meu-projeto
myagent
```

Use `myagent --new` para outra sessão, `myagent resume` para escolher uma,
`myagent doctor` para diagnóstico e `myagent --help` para ajuda.

Os dados ficam em `~/.myagent/` (override: `MYAGENT_HOME`), em SQLite local.
Docker é opcional para abrir o app e obrigatório para shell, typecheck e testes.
Não há execução de comandos do modelo no host. A imagem padrão é
`oven/bun:1.3.13`, configurável por `MYAGENT_SANDBOX_IMAGE`; ferramentas e
dependências específicas podem exigir imagem personalizada.

No Windows, o npm cria `myagent.cmd`. Mantenha Bun e o diretório global do npm
no PATH. Chaves e modelos são configurados pela interface; nunca compartilhe
o conteúdo do diretório global. Não há migração automática de dados antigos
do PostgreSQL.
