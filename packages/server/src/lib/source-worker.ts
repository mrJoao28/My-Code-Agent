import type * as TypeScript from "typescript";
declare const self: Worker;
type SymbolEntry = { name: string; kind: string; line: number; endLine: number; exported: boolean };
self.onmessage = async (event: MessageEvent<{ path: string; text: string; query?: string; caseSensitive?: boolean }>) => {
    try {
        // Keep worker startup lightweight so loading the parser is cancellable too.
        const ts = (await import("typescript")).default;
        const { path, text, query, caseSensitive } = event.data;
        const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        const symbols: SymbolEntry[] = []; let truncated = false;
        const visit = (node: TypeScript.Node) => {
            if (symbols.length >= 200) { truncated = true; return; }
            const declaration = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
                || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node)
                || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isModuleDeclaration(node)
                || ts.isMethodSignature(node) || ts.isPropertySignature(node);
            const declaredName = (node as TypeScript.NamedDeclaration).name;
            if (declaration && declaredName && (ts.isIdentifier(declaredName) || ts.isStringLiteral(declaredName))) {
                const name = declaredName.text;
                if (!query || (caseSensitive ? name.includes(query) : name.toLowerCase().includes(query.toLowerCase()))) {
                    symbols.push({ name: name.slice(0, 200), kind: ts.SyntaxKind[node.kind], line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                        endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
                        exported: Boolean(ts.getCombinedModifierFlags(node as TypeScript.Declaration) & ts.ModifierFlags.Export) });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        self.postMessage({ symbols, truncated });
    } catch { self.postMessage({ error: "SOURCE_PARSE_FAILED" }); }
};
