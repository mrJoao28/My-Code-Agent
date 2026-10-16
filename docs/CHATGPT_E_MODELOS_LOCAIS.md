# ChatGPT e modelos locais

## Conectar um plano ChatGPT

1. Inicie o servidor e a CUI e abra o seletor de modelos.
2. Escolha **Continuar com ChatGPT / gerenciar contas** e depois **Continuar com
   ChatGPT · adicionar conta**.
3. Entre na conta pelo navegador e autorize o uso do plano para o My-Code-Agent.
4. Volte ao terminal e selecione um dos modelos descobertos na conta.

Não é necessário configurar uma API key para essa conexão. Ela usa o fluxo
oficial Sign in with ChatGPT para projetos locais/de código aberto, sujeito à
elegibilidade da conta e às limitações do preview. O aplicativo não garante
acesso a todos os modelos. A lista vem do catálogo da conta; uma inferência
concluída confirma o acesso efetivo ao modelo naquele pedido.

O seletor identifica esses modelos como **plano ChatGPT**. As chamadas usam o
plano autorizado e seus limites; não há fallback automático para uma API key nem
troca silenciosa para cobrança por API. Use **Gerenciar uso do plano ChatGPT**
para abrir as configurações de uso. Quando a sessão expirar ou for revogada,
reconecte a conta. A renovação normal dos tokens ocorre automaticamente.

Na tela de contas é possível selecionar outra conta, reconectar registros salvos
ou desconectar. Contas com o mesmo email continuam separadas pelo registro e pela
identidade verificada. Trocar ou desconectar uma conta interrompe suas gerações
em andamento. Se a revogação remota não for confirmada, a interface informa isso;
também é possível desconectar o aplicativo nas configurações do ChatGPT.

Fechar o diálogo com Esc ou encerrar a CUI cancela a tentativa de login. Se o
navegador não abrir automaticamente, o terminal mostra a URL para abertura manual.
Em uso remoto, o navegador precisa alcançar o callback na máquina do servidor;
esse fluxo foi projetado para a CUI e o backend locais.

## Modelos locais

Em **Adicionar modelo local / API key**, o provedor inicial é **Ollama**. Informe
o identificador exato de um modelo já instalado no Ollama, como `qwen2.5-coder:7b`.
Não há campo de API key para esses modelos. O endereço é definido por
`OLLAMA_BASE_URL`, com padrão `http://localhost:11434/v1`; `OLLAMA_API_KEY` continua
opcional. O aplicativo não instala modelos automaticamente.

Os provedores de API key existentes continuam disponíveis. No formulário, use
as setas para escolher o provedor, Tab para trocar de campo e Enter para salvar.
Esta mudança não adiciona login de assinatura Claude nem altera sua autenticação.

## Credenciais e permissões

O backend guarda o identificador estável da instalação, registros de contas,
catálogo e tokens em `~/.myagent/chatgpt-credentials.json`, ou no diretório privado
indicado por `MYAGENT_HOME` (ou pelo alias `MYAGENT_CONFIG_DIR`). Não são gravados no `.env`, banco de sessões ou
registro de modelos do projeto. No Windows, o diretório deve permanecer no perfil
privado do usuário, protegido pelas ACLs; em POSIX o arquivo usa permissão 0600.
Links, junctions e hard links são recusados. A gravação é atômica e usa um lock
de arquivo para impedir rotação concorrente de credenciais entre processos.
Após encerramento abrupto durante uma atualização, pode restar o arquivo `.lock`;
confirme que nenhum servidor está usando a conexão antes de removê-lo manualmente.

A CUI recebe apenas estado, rótulos de contas e URLs de autorização sem tokens.
O callback OAuth usa um listener temporário em `127.0.0.1`, separado da API, com
validação de state, PKCE, assinatura, issuer, audience, nonce e escopos. As rotas
de controle mantêm o token local e a rejeição de clientes de navegador.

O login não habilita ferramentas adicionais: PLAN/BUILD, aprovações, sandbox
Docker, limites e cancelamento continuam definidos pelo backend. A Responses API
usa streaming com `store: false` e ferramentas em namespace. O histórico continua
no SQLite local. EOF, falha de uso do plano e resposta incompleta não são
considerados conclusão bem-sucedida.

## Verificação

```sh
bun test
bun run typecheck
```

Os testes simulam os servidores OpenAI e não usam credenciais reais nem créditos.
Incluem validação criptográfica dos tokens, callbacks inválidos/repetidos,
cancelamento, refresh concorrente, armazenamento privado, múltiplas contas,
autenticação das rotas e chamadas de ferramentas pelo AI SDK real com rede simulada.
O login real e a elegibilidade precisam ser verificados pelo usuário no navegador.

Fontes oficiais:

- [Registro e login](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Contas e sessões](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Modelos e inferência](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Limitações do preview](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
