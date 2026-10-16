# Janela de contexto, prompts e limites

Cada sessão possui uma linha em `SessionContext`, removida em cascata junto com
a sessão. Novas sessões recebem a linha na criação; sessões anteriores são
inicializadas ao iniciar uma geração.

O padrão é **16.384 tokens estimados de histórico**: bytes UTF-8 do JSON divididos
por três, com margem por mensagem. Não é tokenização exata nem o contador de
consumo. Prompt do sistema, schemas de ferramentas e saída também ocupam a janela
real do provedor, fora desse orçamento de histórico. Modelos locais com contexto
menor exigem `tokenLimit` menor na linha da sessão e configuração compatível no
runtime. O limite da aplicação não aumenta a capacidade do modelo.

Antes da geração, até 80 mensagens recentes são reconstruídas. Antes de cada
etapa do SDK, a janela é validada, limitada e persistida; o conteúdo retornado
pelo banco segue para o modelo. Turnos antigos saem primeiro. Pares de chamada e
resultado permanecem juntos; trechos extensos podem ser abreviados com indicação.
O histórico completo permanece salvo. Uma mensagem atual que sozinha não caiba
retorna `CONTEXT_MESSAGE_TOO_LARGE`, sem corte silencioso.

Chamadas incompletas viram notas sem execução automática. Reasoning não é
reconstruído em novos turnos; metadados e reasoning necessários à continuação do
provider no fluxo atual são preservados. Após conclusão, erro ou interrupção com
conteúdo persistido, o snapshot é atualizado. Se essa atualização falhar, a
próxima geração o reconstrói das mensagens. Falha ao salvar a janela antes de uma
chamada ao modelo impede a chamada. Locks continuam locais ao processo.

Os prompts ativos usam nomes reais, seções separadas, PLAN com evidências e
critérios de aceite e BUILD alinhado à sandbox. O builder recebe as ferramentas
efetivamente disponíveis. O carregamento automático de instruções de projeto
permanece fora desta mudança.

Busca web e fetch propagam cancelamento, têm deadline de 15 segundos e limitam
bytes durante a leitura: 1 MB para busca e 5 MiB para fetch. Bodies são cancelados
em falhas, redirects e limites. Respostas de busca são validadas e falhas de
formato sanitizadas. A checagem existente de destinos foi mantida; pinning de DNS
contra rebinding não foi implementado nesta mudança.

Grep usa worker cancelável, até 15 segundos, 20 MB de leitura, 20 mil entradas e
200 resultados. Suporta regex e busca literal. Listagens têm até 500 itens por
página e 20 mil entradas examinadas; `nextOffset` pressupõe diretório inalterado.
Leituras e processos Git recebem cancelamento. Cancelar após uma mutação não
desfaz efeitos concluídos: confira o resultado antes de tentar novamente.

A migration `20261016010000_session_context` cria a tabela. Após conferir o alvo:

```sh
bun run --cwd packages/database db.deploy
bun run --cwd packages/database db.generate
```

Testes normais simulam IA e rede. `bun run test:database` valida persistência,
isolamento entre sessões, recarga e cascata em PostgreSQL temporário do Docker,
sem usar o banco de desenvolvimento ou créditos de IA.
