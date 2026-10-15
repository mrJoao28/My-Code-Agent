# Consumo de tokens da sessão

A barra abaixo da caixa de texto soma os tokens de entrada e saída informados
pelo provedor em cada etapa da geração, incluindo etapas com ferramentas. Ela
usa as cores do tema ativo e mostra o total à direita: `1.2k` para milhares e
`2.5M` para milhões. O valor é atualizado quando o provedor informa o uso de
uma etapa, não a cada caractere recebido.

A escala visual é de 1 milhão de tokens acumulados. Ao atingir esse valor,
a barra permanece cheia e o número continua aumentando. Essa escala não é um
limite de contexto, de plano ou de cobrança.

O consumo conhecido é salvo em `Message.totalTokens`, inclusive em falhas e
interrupções, e restaurado ao abrir a sessão. Mensagens anteriores à mudança e
etapas sem informação de uso não são estimadas: o contador representa somente
o consumo informado. Uma etapa interrompida antes de informar uso pode consumir
tokens sem que o aplicativo consiga contabilizá-los.

Antes de executar a versão atualizada, confira o banco-alvo e aplique a migration
`20261015120000_message_token_usage` usando as migrations existentes:

```sh
bun run --cwd packages/database db.deploy
```

Os testes automatizados usam provedores e transporte simulados; não consomem
créditos de IA. Cobrem soma de etapas, recarga, erro, cancelamento, falha no
transporte, formatação, terminais estreitos e as paletas dos temas disponíveis.
