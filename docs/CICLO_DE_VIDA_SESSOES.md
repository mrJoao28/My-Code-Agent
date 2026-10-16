# Ciclo de vida das sessões

Uma sessão expira após 10 dias completos (240 horas) sem atividade. Abrir uma
sessão, enviar uma mensagem ou retomar uma geração renova `Session.updatedAt`.
As mensagens persistidas também contam como atividade. Apenas listar o histórico
de sessões não renova o prazo; deixar uma sessão aberta sem interação também não.

Sessões expiradas deixam de aparecer na lista e retornam 404 ao serem abertas ou
usadas no chat. Elas não podem ser reativadas antes da próxima limpeza. Uma sessão
renovada antes do prazo ganha outros 10 dias a partir do uso.

O servidor remove as sessões expiradas ao iniciar e verifica novamente a cada
hora, após a conclusão da verificação anterior. As mensagens são removidas pela
relação com `onDelete: Cascade` já existente. A exclusão é definitiva. Com o
servidor desligado, a limpeza aguarda a próxima inicialização.

A exclusão verifica as datas em uma consulta condicional, sem carregar uma lista
de IDs para apagar depois. Mensagens recentes protegem registros antigos cujo
`updatedAt` não tenha sido atualizado corretamente. A abertura e o chat renovam
a atividade antes de carregar o histórico; se a renovação falhar, a operação não
inicia. As gerações continuam limitadas aos cinco minutos existentes.

A rotina não sobrepõe seus próprios ciclos, tenta novamente no próximo intervalo
em caso de erro e não mantém o processo aberto só pelo timer. Ao recarregar o
servidor com Bun `--hot`, o timer anterior é cancelado. Não há serviço externo nem
cron do sistema; a política se aplica às sessões no banco configurado da API local.

O índice de `Session.updatedAt` agora integra a baseline SQLite. A migration
PostgreSQL `20261016000000_session_retention` está arquivada. Para abrir e migrar
o banco SQLite local, após conferir MYAGENT_HOME:

```sh
bun run --cwd packages/database db.deploy
```

Os testes normais simulam o banco e o agendamento. Cobrem o prazo, a renovação antes
da leitura, sessões expiradas ou removidas, autenticação, falhas, repetição e
cancelamento do timer. A retenção e a exclusão em cascata também são verificadas
em SQLite temporário em `bun run test:database`, sem Docker nem configuração extra.
