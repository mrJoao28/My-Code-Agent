export type Command = "open" | "resume" | "doctor" | "help" | "version";
export function parseOptions(args: string[]): { command: Command; createNew: boolean; all: boolean } {
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
  myagent --version      Exibe a versão.
  myagent --help         Exibe esta ajuda.

Configuração: ~/.myagent/ (sobrescreva com MYAGENT_HOME).
Docker é opcional para abrir o app; comandos exigem a sandbox Docker.`;
