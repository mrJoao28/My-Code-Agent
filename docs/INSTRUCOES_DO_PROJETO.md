# Instruções do projeto sem documentação automática

No início de cada geração com workspace autorizado, o servidor lê o `AGENTS.md`
da raiz e o inclui na seção **INSTRUÇÕES DO PROJETO** do system prompt. Não lê
instruções acima do workspace. Sem arquivo legível, não presume seu conteúdo.

Ao acessar um arquivo, o carregador procura os `AGENTS.md` de seus ancestrais,
da raiz até a pasta mais específica. As regras da raiz são gerais; as locais
prevalecem somente em seu próprio escopo. Pastas irmãs não se sobrepõem.
Solicitações explícitas do usuário e as permissões do backend têm prioridade.
Todos os textos são dados não confiáveis: não autorizam ferramentas, rede,
execução no host ou acesso a caminhos bloqueados.

As ferramentas de leitura e edição recebem uma nota `projectInstructions` no
resultado, preservando os campos originais. Cada instrução informa `path`,
`scope`, `text` e `truncated`. A nota é anexada na primeira entrega bem-sucedida
daquela fonte na geração; chamadas seguintes reutilizam o cache sem repetir o
texto. A raiz já entregue no system prompt não é repetida nas ferramentas.
Leituras em lote, arquivos novos com ancestrais existentes, movimentos e patches
também procuram instruções aplicáveis. Buscas e inspeções carregam instruções
das pastas dos arquivos apresentados nos resultados.

Leia os arquivos relevantes antes de editar, para que o modelo receba e possa
aplicar as regras locais. A nota anexada a uma edição chega depois de sua execução
e não substitui essa leitura prévia.

O cache pertence somente à geração e inclui ausências e falhas. Alterações em
`AGENTS.md` são observadas na geração seguinte. O total das notas automaticamente
entregues é limitado a **16 KiB**, incluindo JSON, escapes e cabeçalhos; a raiz
tem prioridade. A reserva é serializada para não exceder o limite quando várias
ferramentas rodam em paralelo. Há também limites de 128 candidatos e 32 níveis
de subpastas por geração. `limited` ou `truncated` indica cobertura incompleta;
não presuma regras omitidas e leia explicitamente os trechos necessários.

Toda leitura passa por `resolveSafePath`. Links simbólicos, junctions, hard links
e tipos que não sejam arquivos regulares são recusados, sem seguir seus alvos.
Falhas aparecem como `blocked` ou `unavailable`, sem conceder permissões nem
impedir a leitura de um arquivo comum independente. Cancelamento interrompe as
leituras e os descritores são fechados. Essas verificações no host não constituem
uma sandbox contra outro processo trocando arquivos durante a operação.

O carregador **nunca grava arquivos**. O prompt BUILD não exige criar `AGENTS.md`
ou `RESUME.md` em pastas alteradas, nem transformar a raiz em mapa. O resumo das
alterações e verificações deve estar na resposta. Criar documentação depende do
pedido do usuário; sobrescrever ou reorganizar um `AGENTS.md` existente exige
pedido explícito e continua sujeito à aprovação normal das ferramentas.
Não existe comando ou variável que ative documentação automática nesta mudança.
