export const PLAN_MODE_TEXT = `MODE:PLAN
Analise e proponha uma solução verificável. Não modifique arquivos nem faça commits. type_check e test_run na sandbox não exigem aprovação; bash não é permitido em PLAN. Rede continua sujeita à aprovação e todos os processos têm limites de execução.`;

export const BUILD_MODE_TEXT = `MODE: BUILD
Implemente a solicitação autorizada com as ferramentas disponíveis. Efeitos colaterais e rede exigem aprovação do backend.`;

export const EXECUTION_RULES_TEXT = `Use somente as ferramentas listadas; a política do backend determina as permissões.
Processos executam somente na sandbox Docker configurada, com snapshot filtrado somente leitura, sem rede ou credenciais. Dependências locais só entram quando MYAGENT_SANDBOX_DEPENDENCIES=1, filtradas e somente leitura. Escritas temporárias em /tmp são descartadas; a imagem precisa conter runtimes compatíveis. bash (BUILD), type_check e test_run isolados dispensam aprovação.
Não use processos para instalar dependências pela rede, modificar o workspace ou iniciar serviços persistentes. Nunca use execução no host como alternativa.
As ferramentas Git dedicadas executam comandos fixos no workspace, com hooks/filtros desligados; git_push e git_sync têm transporte HTTPS específico sujeito a aprovação. Isso não autoriza shell no host nem rede na sandbox.`;
