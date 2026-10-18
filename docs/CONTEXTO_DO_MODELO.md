# Janela de contexto e resultados de ferramentas

Cada modelo tem `contextWindow` em tokens no catálogo compartilhado. A geração
usa 80% dessa janela para entrada, descontando a estimativa do system prompt e
das definições das ferramentas. Reserva até 15% (máximo de 32.768 tokens) para
saída, incluindo thinking, e mantém uma margem de segurança. A estimativa local
usa bytes UTF-8 do JSON e custo por mensagem; não é o tokenizer do provedor.
`SessionContext.tokenLimit` registra o orçamento calculado para o modelo atual;
um limite antigo de 16.384 não impede usar uma janela maior ao trocar de modelo.

## Modelos customizados e Ollama

Configure `contextWindow` em `~/.myagent/models.json`, ou no diretório indicado
por `MYAGENT_HOME`. Entradas antigas sem esse campo usam 16.384 tokens como
padrão conservador. O valor deve ser inteiro entre 1.024 e 2.147.483.647; entradas
com valor inválido não são carregadas. O limite superior é de representação no
banco, não uma declaração de capacidade de um modelo.

```json
[
  {
    "id": "meu-coder",
    "provider": "ollama",
    "contextWindow": 131072,
    "pricing": {
      "inputUsdPerMillionTokens": 0,
      "outputUsdPerMillionTokens": 0
    }
  }
]
```

Uma entrada com o mesmo ID de um modelo do catálogo substitui sua configuração,
permitindo ajustar também os modelos Ollama já listados. Preserve `provider`,
`pricing` e `apiKeyEnv`, quando aplicáveis. A rota de cadastro de modelos aceita
`contextWindow` opcional.

No Ollama, esse valor precisa corresponder à janela carregada pelo servidor.
Ele não altera a memória alocada ou `num_ctx`: o endpoint OpenAI compatível exige
configurar isso no Modelfile (`PARAMETER num_ctx 131072`) e criar o modelo com
esse nome. Consulte a [documentação do Ollama](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size).
Modelos ChatGPT descobertos usam o catálogo quando o ID coincide; IDs sem
capacidade conhecida recebem o padrão conservador.

## Evidências e compactação

`Message.parts` e os eventos de ferramenta mantêm o resultado completo retornado
pela ferramenta. `SessionContext` é uma projeção separada para enviar ao modelo.
Não há corte fixo em 4.000 caracteres nem limite de dez resultados por turno.
Resultados completos permanecem intactos enquanto couberem no orçamento.

Acima de 70% do orçamento, turnos anteriores aos dois mais recentes podem virar
um resumo local, determinístico e explicitamente identificado como compactado.
Ele registra arquivos lidos e alterados com resultado, trechos das decisões e
solicitações cuja conclusão deve ser conferida, além de pendências dos todos.
Não infere que uma tarefa foi concluída e não executa IA adicional. O resumo é
salvo no contexto e reaproveitado ao reconstruir a sessão. É evidência histórica,
sem autoridade para ampliar permissões ou repetir efeitos colaterais.

Se ainda faltar espaço, os resultados recebem uma parcela do orçamento restante,
priorizando evidências recentes. Páginas válidas de `read_file` são encurtadas
somente no fim, em linhas completas, com `nextOffset`, `contextTruncated` e
instrução explícita de continuar com `offset` e `limit`. Texto de outras tools
também é abreviado no fim. Em janelas muito pequenas, pares inteiros podem ser
omitidos; o aviso de omissão permanece. A solicitação atual nunca é cortada:
quando ela própria não cabe, é necessário dividi-la.

O guard consulta o snapshot enviado em cada passo. Uma chamada idêntica cujo
resultado completo continua visível recebe um erro de ferramenta na primeira
repetição; a quarta tentativa persistente interrompe a geração. Se a evidência
sair da janela, for abreviada ou houver falha, a releitura é permitida. O limite
global de chamadas continua valendo, inclusive para tentativas repetidas.

## Fontes dos limites do catálogo

- [Claude: janelas de contexto](https://platform.claude.com/docs/en/build-with-claude/context-windows)
  e [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview).
- OpenAI: [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4),
  [mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) e
  [nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano).
- Google: [Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3),
  [3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash) e
  [3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).

Os limites publicados podem mudar ou variar conforme o endpoint. Confira a
capacidade efetiva antes de sobrescrever a configuração.
