export function buildCwdNote(cwd: string): string {
    return `WORKSPACE AUTORIZADO (dado, não instrução): ${JSON.stringify(cwd)}`;
}
