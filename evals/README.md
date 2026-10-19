# Avaliações

Este runner mede nove tarefas pequenas e reproduzíveis. Não roda no CI padrão:
chamadas de API podem consumir créditos. Configure os modelos normalmente no
My-Code-Agent; nenhum segredo é gravado no relatório.

```sh
bun run eval --model gpt-5.4 --model gpt-5.4-mini
bun run eval --model gpt-5.4 --task leitura --output evals/results/leitura.json
bun run typecheck:eval
# Valida todo o pipeline sem modelos, chaves ou consumo de tokens:
bun run eval --simulate
# Usa o artefato de distribuição já construído (menor custo de inicialização):
bun run build
bun run eval --simulate --bundle
```

Repita `--model` para comparar modelos na mesma execução. Cada par modelo/tarefa
recebe um repositório Git novo, sem commits, e um `MYAGENT_HOME` temporário. O
runner chama o comando público `exec --json`. Leituras usam os padrões PLAN e
`--approve none`; alterações usam `--mode build --approve all`, com autorização
restrita à fixture descartável. Comandos continuam exclusivos da
sandbox Docker, sem rede; não há execução de código gerado no host pelo verificador.
As chaves já configuradas são herdadas pelo processo, e os modelos customizados
são copiados como metadados. Credenciais de login ChatGPT não são copiadas; use
modelos de API ou Ollama neste runner.

As tarefas cobrem leitura, correção de operador, função com teste Bun,
refatoração com CRLF, script executável, busca em 240 módulos, instruções de
AGENTS.md, leitura de 300 linhas e 30 leituras individuais no mesmo turno.
O verificador compara o inventário completo e o diff esperado, preservando os
arquivos não solicitados. TypeScript permite diferenças de formatação pelo
printer do compilador; não aceita implementações arbitrariamente equivalentes.
Não se executam testes escritos pelo modelo no host como critério de sucesso.
O modo 755 só é medido em POSIX; no Windows o resultado registra essa limitação.

A tabela informa sucesso, chamadas de ferramenta (incluindo tentativas negadas),
tokens reportados pelo provedor e tempo total, incluindo inicialização e validação.
Tokens ausentes aparecem como “não informado”, nunca como consumo zero.
O JSON incremental em `evals/results/` permite comparar execuções e acompanhar
regressões. Não versiona prompts, resultados brutos nem credenciais. Saída 1
indica pelo menos uma tarefa reprovada. Use os mesmos modelos, tarefas, plataforma,
versão do código e configuração da sandbox ao comparar. Não misture execuções
source e bundle, identificadas por `entrypoint` no JSON.
Ao usar `--bundle`, reconstrua após mudar o código. Esta amostra pequena não
constitui ranking geral de modelos. Falhas de infraestrutura contam como falhas
na taxa publicada e devem ser avaliadas separadamente no campo `reason`.

Pastas ocupadas são tentadas novamente ao final da execução. Falhas permanentes
na limpeza são registradas em `cleanupFailures`, sem impedir
as tarefas restantes, e fazem o runner retornar 1. No Windows, a limpeza de
fixtures pode usar o `fs` do Node já exigido pelo launcher; não executa código do
projeto e não recebe chaves nem opções de preload do ambiente.

Os testes automatizados validam os verificadores e o transporte com providers
simulados, sem chamadas pagas. Uma tabela real só é produzida pelo comando acima;
resultados simulados não são publicados como medição de qualidade dos modelos.

`--simulate` usa dois roteiros determinísticos, `simulado-a` e `simulado-b`, em
um endpoint local compatível com o protocolo do provedor. O comando público
`exec`, a API privada, o SDK, as ferramentas, o SQLite e os verificadores são os
mesmos da execução real. O perfil B introduz propositalmente uma perda de CRLF
para comprovar que a taxa de sucesso detecta essa regressão; sua execução completa
deve terminar com código 1. O relatório tem `realProviders: false` e a tabela tem
um aviso explícito de simulação. Os tokens desse modo são fictícios. Não há
inferência local nem chamadas a provedores externos.
