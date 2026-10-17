import { expect, test } from "bun:test";
import ts from "typescript";
import { resolve } from "node:path";

// Deliberately small: catches literal text, explicit spaces/numbers, conditional
// branches and map callbacks. Dynamic ReactNode props still need render tests.
function looseText(source: string, path: string) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const failures: string[] = [];
    const textTags = new Set(["text", "span", "em", "b", "i", "u", "a"]);
    function primitive(node: ts.Expression): boolean {
        if (ts.isStringLiteralLike(node)) return node.text.length > 0;
        if (ts.isNumericLiteral(node)) return true;
        if (ts.isParenthesizedExpression(node)) return primitive(node.expression);
        if (ts.isConditionalExpression(node)) return primitive(node.whenTrue) || primitive(node.whenFalse);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return primitive(node.right);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
            const callback = node.arguments[0];
            if (callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) return primitive(callback.body);
        }
        return false;
    }
    function visit(node: ts.Node, insideText = false) {
        if (ts.isJsxSelfClosingElement(node)) return;
        if (ts.isJsxElement(node)) {
            const tag = node.openingElement.tagName.getText(file);
            for (const child of node.children) visit(child, textTags.has(tag));
            return;
        }
        if (!insideText && (ts.isJsxText(node) && (node.text.trim().length > 0 || !/[\r\n]/.test(node.text) && node.text.length > 0)
            || ts.isJsxExpression(node) && node.expression && primitive(node.expression))) {
            failures.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
        ts.forEachChild(node, child => visit(child, insideText));
    }
    visit(file);
    return failures;
}

test("CUI has no literal primitive children outside terminal text nodes", async () => {
    const root = resolve(import.meta.dirname, "..");
    const failures: string[] = [];
    for await (const path of new Bun.Glob("packages/cui/src/**/*.tsx").scan(root)) {
        if (path.includes(".test.")) continue;
        failures.push(...looseText(await Bun.file(resolve(root, path)).text(), path));
    }
    expect(failures).toEqual([]);
});

test("text guard catches spaces, numbers, branches, fragments and map strings", () => {
    for (const source of ['<box>oops</box>', '<box>{" "}</box>', '<box>{0}</box>', '<box><>{ok && "oops"}</></box>', '<box>{ok ? "a" : "b"}</box>', '<box>{items.map(x => "oops")}</box>']) {
        expect(looseText(source, "fixture.tsx").length).toBeGreaterThan(0);
    }
    expect(looseText('<box><text>{value} <span>ok</span></text>{ok && <text>ok</text>}</box>', "fixture.tsx")).toEqual([]);
});
