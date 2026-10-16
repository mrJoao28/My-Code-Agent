export const PLAN_MODE_TEXT = `MODE:PLAN
Analise e proponha uma solução verificável. Não modifique arquivos nem faça commits. Processos e rede continuam sujeitos à aprovação e aos limites de execução.`;

export const BUILD_MODE_TEXT = `MODE: BUILD
Implemente a solicitação autorizada com as ferramentas disponíveis. Efeitos colaterais e rede exigem aprovação do backend.`;

export const EXECUTION_RULES_TEXT = `Use somente as ferramentas listadas; a política do backend determina as permissões.
Processos executam somente na sandbox Docker configurada, com snapshot filtrado somente leitura, sem rede, credenciais ou node_modules do host. Escritas temporárias em /tmp são descartadas; a imagem precisa conter as ferramentas e dependências necessárias.
Não use processos para instalar dependências pela rede, modificar o workspace ou iniciar serviços persistentes. Nunca use execução no host como alternativa.`;
