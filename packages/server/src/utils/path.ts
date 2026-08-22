import { resolve, relative, sep } from "path";
import { realpath } from "fs/promises";


export class UnsafePathError extends Error {
    constructor(targetPath: string) {
        super(`Path "${targetPath}" está fora do diretório de trabalho`);
        this.name = "UnsafePathError";
    }
}

export class PathNotFoundError extends Error {
    constructor(targetPath: string) {
        super(`Path "${targetPath}" não existe`);
        this.name = "PathNotFoundError";
    }
}

function isInside(root: string, resolved: string): boolean {
    if (resolved === root) return true;
    const rel = relative(root, resolved);
    return !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && rel !== "..";
}


export async function resolveSafePath(
    cwd: string,
    targetPath: string,
    options: { mustExist?: boolean } = {}
): Promise<string> {
    const mustExist = options.mustExist ?? true;

    const root = await realpath(cwd).catch(() => resolve(cwd));
    const resolvedTarget = resolve(root, targetPath);

    if (!isInside(root, resolvedTarget)) {
        throw new UnsafePathError(targetPath);
    }

    try {
        const real = await realpath(resolvedTarget);
        if (!isInside(root, real)) {
            throw new UnsafePathError(targetPath);
        }
        return real;
    } catch (e) {
        if (e instanceof UnsafePathError) throw e;

        // O caminho final não existe (ou não pôde ser resolvido via
        // realpath). Isso NÃO dispensa a validação de symlink: um
        // diretório intermediário já existente no caminho pode ser um
        // symlink apontando para fora do `cwd`, e o arquivo final ainda
        // não existir só significa que o realpath completo falhou — não
        // que o caminho seja seguro. Por isso validamos o diretório-pai
        // real independentemente do valor de `mustExist`.
        const parentDir = resolve(resolvedTarget, "..");
        try {
            const realParent = await realpath(parentDir);
            if (!isInside(root, realParent)) {
                throw new UnsafePathError(targetPath);
            }
        } catch (parentErr) {
            if (parentErr instanceof UnsafePathError) throw parentErr;
            // Diretório-pai também não existe — nada mais a validar aqui;
            // se `mustExist` for true isso já será reportado abaixo.
        }

        // BUGFIX: antes, quando `mustExist` era `true` e o arquivo não
        // existia, a função simplesmente devolvia `resolvedTarget` sem
        // lançar nenhum erro — ou seja, a opção "mustExist" não tinha
        // nenhum efeito prático além de pular a checagem de symlink
        // acima (que também era pulada, agravando o problema). Isso
        // deixava a responsabilidade de reportar "arquivo não encontrado"
        // inteiramente para a chamada de fs subsequente (ex.: `open()`),
        // resultando em erros menos claros para o modelo/usuário e, mais
        // importante, sem qualquer validação de symlink no caminho.
        if (mustExist) {
            throw new PathNotFoundError(targetPath);
        }

        return resolvedTarget;
    }
}


export function toRelative(cwd: string, absolutePath: string): string {
    return relative(cwd, absolutePath) || ".";
}