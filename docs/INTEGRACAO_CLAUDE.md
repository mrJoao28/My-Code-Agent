# Integração Claude: autenticação e proposta de implementação

Consulta às fontes oficiais: 15/10/2026.

## Estado atual

O My-Code-Agent já possui o provider `anthropic`, integrado ao Vercel AI SDK, com autenticação por API key. A conexão ChatGPT é uma implementação separada, com registro, callback OAuth e catálogo da conta. Não há conexão de assinatura Claude implementada nesta etapa.

A alteração deste documento não habilita login, envio de mensagens nem testes de uma integração Claude nova.

## Diferença em relação ao ChatGPT

As fontes oficiais consultadas precisam ser lidas em conjunto:

- O [suporte sobre Agent SDK e plano Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) informa que SDK, `claude -p` e aplicativos terceiros continuam podendo usar os limites da assinatura. A atualização de 7 de outubro também descreve créditos mensais de API para Max e Team. Isso não garante acesso para toda conta nem equivale a um protocolo público de OAuth para qualquer aplicativo.
- A [visão geral do Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) ainda exige autorização prévia para terceiros oferecerem login claude.ai e limites do plano em seus produtos. Essa redação deixa uma diferença de escopo em relação ao artigo de suporte.
- A seção [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) restringe a coleta e intermediação de credenciais e tokens claude.ai por terceiros. Ela distingue esse caso do usuário entrar com sua própria assinatura no binário oficial, sem modificações, inclusive em uma plataforma que hospede o Claude Code nas condições descritas na mesma página.

Portanto, a implementação proposta não deve copiar o fluxo OAuth do ChatGPT, reutilizar o identificador de cliente do Claude Code nem ler seu arquivo privado de tokens. O caminho indicado para avaliação é executar o cliente oficial, deixando autenticação e armazenamento de credenciais a cargo dele.

## Caminho proposto: cliente oficial

1. Detectar a instalação do Claude Code e fornecer instruções se estiver ausente. Não instalar ou atualizar o executável silenciosamente.
2. Usar os comandos oficiais `claude auth login` e `claude auth status`. O usuário conclui o fluxo do próprio Claude no navegador. A aplicação recebe somente estado e diagnóstico sanitizado, sem copiar tokens.
3. Separar a opção de assinatura da opção Anthropic por API key. Não fazer fallback silencioso entre elas. Verificar o método de autenticação efetivo, porque o cliente suporta diferentes fontes de credenciais e faturamento.
4. Usar o binário oficial por sua interface suportada ou pelo Agent SDK, em vez de enviar os tokens da assinatura diretamente ao endpoint de Messages pelo provider atual.
5. Integrar o mecanismo de geração ao ciclo de SSE e persistência existente. Somente um resultado explícito de sucesso confirma a conclusão; EOF, cancelamento e erro não podem produzir uma mensagem marcada como completa.
6. Expor as ferramentas existentes do My-Code-Agent por uma ponte controlada. As ferramentas nativas de execução e acesso ao host não podem criar um caminho alternativo às restrições de PLAN/BUILD, workspace, aprovação e sandbox Docker.
7. Limitar saída durante a leitura, propagar cancelamento e liberar processos, listeners e timers ao fechar a CUI ou interromper uma geração.

O cliente oficial pode ter uma conta já usada fora do My-Code-Agent. A interface precisa explicar esse compartilhamento antes de oferecer logout ou troca de conta; não se deve prometer o mesmo gerenciamento independente de múltiplas contas implementado para ChatGPT.

Referências de implementação: [CLI reference](https://code.claude.com/docs/en/cli-reference), [autenticação](https://code.claude.com/docs/en/authentication), [ferramentas customizadas do SDK](https://code.claude.com/docs/en/agent-sdk/custom-tools).

## Testes necessários para a implementação

| Área | Casos mínimos |
| --- | --- |
| Instalação e autenticação | Cliente ausente, login concluído, cancelado ou expirado; conta sem acesso; método de autenticação incompatível com a opção escolhida |
| Credenciais | Nenhum token na API local, logs, banco ou fixtures; ausência de fallback silencioso para API key |
| Geração | Texto incremental, uso de ferramentas, resultado explícito de sucesso, EOF sem resultado, falha após texto parcial e limite do plano |
| Permissões | PLAN sem mutações; BUILD sujeito à aprovação; ferramenta desconhecida negada; nenhum shell ou acesso a arquivos fora das ferramentas protegidas |
| Cancelamento | Interrupção durante rede, aprovação e ferramenta; limpeza de processos e listeners; fechamento do diálogo |
| Persistência | Histórico e pares de ferramenta coerentes após reload; mensagens interrompidas identificadas; nenhuma execução duplicada |
| CUI | Enter, setas, Esc, Ctrl+C, retorno ao seletor e foco do input de fundo |

Os testes padrão devem simular o cliente e o provider; não precisam de conta real nem devem consumir assinatura ou créditos. Uma verificação manual real continua necessária para confirmar a instalação, o login e a elegibilidade da conta do usuário.

## Decisão de escopo pendente

Confirmar se a experiência desejada aceita exigir o Claude Code oficial instalado na máquina. A alternativa é melhorar o fluxo já existente de API key, com faturamento separado da assinatura. Essa escolha determina o motor de geração e não pode ser tratada apenas como uma troca de URL ou de marca no login ChatGPT.
