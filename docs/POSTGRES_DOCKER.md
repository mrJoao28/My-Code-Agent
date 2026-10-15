# PostgreSQL local no Docker

O `compose.yaml` cria um PostgreSQL 16 com volume persistente, healthcheck e porta
publicada apenas em `127.0.0.1`. Os outros containers da máquina não são alterados.
O backend e a CUI continuam executando no host com Bun.

Configure no `.env` existente, preservando as demais variáveis:

```dotenv
POSTGRES_PASSWORD=replace-with-a-random-local-password
POSTGRES_PORT=5433
POSTGRES_DB=myagent
DATABASE_URL="postgresql://myagent:replace-with-a-random-local-password@127.0.0.1:5433/myagent"
```

Use uma senha aleatória e a mesma senha nos dois valores. Caracteres especiais na
senha precisam de codificação de URL em `DATABASE_URL`. Não versione o `.env`.
Se alterar a porta ou o nome do banco, atualize também `DATABASE_URL`.

Na raiz do repositório:

```sh
bun run db:up
docker compose exec -T postgres psql -U myagent -d myagent -c "SELECT current_database(), current_user;"
bun run --cwd packages/database db.generate
bun run --cwd packages/database db.deploy
bun run dev:server
```

`db:up` espera o healthcheck. Inspecione o banco-alvo antes de aplicar migrations;
`db.deploy` aplica somente migrations existentes, sem criar migrations nem resetar
o banco. Inicie a CUI em outro terminal com `bun run dev:cli`.

Para consultar o estado ou parar o banco preservando os dados:

```sh
docker compose ps
bun run db:stop
```

O volume `myagent_postgres_data` preserva os dados entre reinícios e recriações
do container. A senha e o nome do banco são usados na inicialização do volume;
alterar o `.env` depois não altera automaticamente usuários ou bancos existentes.
Não remova o volume para corrigir erros de conexão.

## Teste real de integração

```sh
bun run test:database
```

O comando usa o mesmo Compose em um projeto com nome aleatório, senha temporária,
porta de loopback alocada pelo Docker e banco `myagent_test`. Aplica as migrations,
executa testes reais da rota de sessões com Prisma/PostgreSQL e remove somente os
containers e volumes desse projeto temporário ao terminar, inclusive em falhas.
O banco de desenvolvimento não é usado. Se o processo for encerrado à força, pode
restar um projeto com prefixo `myagent-db-test-` para limpeza manual.

Os testes cobrem criação da sessão com a primeira mensagem, recarga por outro
cliente, persistência de partes JSON, exclusão em cascata e rollback de transação.
Não chamam modelos de IA. Sem `MYAGENT_TEST_DATABASE_URL`, esses testes ficam
ignorados em `bun test`; isso não equivale a uma integração aprovada.

A integração Docker de isolamento de ferramentas permanece separada, disponível
em `bun run test:integration` com `MYAGENT_TEST_DOCKER_IMAGE` configurada.

Referência: [serviços, portas, volumes e healthchecks no Docker Compose](https://docs.docker.com/reference/compose-file/services/).
