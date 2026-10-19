export type ExecOptions = { prompt: string; mode: "plan" | "build"; model?: string; json: boolean; approve: "none" | "reads" | "all" };
export type Command = "open" | "resume" | "doctor" | "help" | "version";
export function parseOptions(args: string[]): { command: Command; createNew: boolean; all: boolean } | ({ command: "exec" } & ExecOptions) {
    if (args[0] === "exec") {
        const options: ExecOptions = { prompt: "", mode: "plan", json: false, approve: "none" };
        const seen = new Set<string>();
        for (let i = 1; i < args.length; i++) {
            const arg = args[i]!;
            if (!arg.startsWith("--")) {
                if (options.prompt) throw new Error("Informe um único prompt entre aspas. Use myagent --help.");
                options.prompt = arg;
                continue;
            }
            if (seen.has(arg)) throw new Error("Opção repetida: " + arg);
            seen.add(arg);
            if (arg === "--json") { options.json = true; continue; }
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error("Valor ausente: " + arg);
            if (arg === "--mode" && (value === "plan" || value === "build")) options.mode = value;
            else if (arg === "--approve" && ["none", "reads", "all"].includes(value)) options.approve = value as ExecOptions["approve"];
            else if (arg === "--model" && value.trim()) options.model = value;
            else throw new Error("Opção inválida: " + arg + ". Use myagent --help.");
        }
        if (!options.prompt.trim() || options.prompt.length > 100_000) throw new Error("Informe um prompt de 1 a 100.000 caracteres. Use myagent --help.");
        return { command: "exec", ...options };
    }
    if (args.length === 0) return { command: "open", createNew: false, all: false };
    if (args.length === 1 && args[0] === "--new") return { command: "open", createNew: true, all: false };
    const commands: Record<string, Command> = { resume: "resume", doctor: "doctor", "--help": "help", "-h": "help", "--version": "version", "-v": "version" };
    const command = commands[args[0]!];
    if (command && (args.length === 1 || command === "resume" && args.length === 2 && args[1] === "--all")) return { command, createNew: false, all: args[1] === "--all" };
    throw new Error("Comando inválido. Use myagent --help.");
}

export const HELP = `My-Code-Agent — requer Bun >= 1.3.13.

  myagent                Retoma a última sessão desta pasta, ou cria uma.
  myagent --new          Cria outra sessão nesta pasta.
  myagent resume         Escolhe uma sessão da pasta (ou de todas as pastas).
  myagent resume --all   Lista sessões de todas as pastas.
  myagent doctor         Verifica runtime, Docker, imagem, banco e configuração.
  myagent exec "prompt"  Executa sem CUI em uma sessão nova.
    --mode plan|build    Padrão: plan.
    --model ID           Modelo do catálogo (padrão do aplicativo se omitido).
    --json               Eventos e resultado final em JSONL no stdout.
    --approve none|reads|all
                         none: leituras locais; reads: também rede de leitura;
                         all: autoriza ações, inclusive escritas e comandos.
                         Padrão none; comandos sempre exigem Docker.
    Saída: 0 sucesso; 1 falha; 3 aprovação negada; 130 cancelamento.
  myagent --version      Exibe a versão.
  myagent --help         Exibe esta ajuda.

Configuração: ~/.myagent/ (sobrescreva com MYAGENT_HOME).
Docker é opcional para abrir o app; comandos exigem a sandbox Docker.`;
