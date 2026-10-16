import { expect, test } from "bun:test";
import { buildSystemPrompt } from "./index";
import { createTools } from "../tools";

test.each(["PLAN", "BUILD"] as const)("%s prompt reflects actual names, capabilities and execution policy", mode => {
    const tools = Object.keys(createTools("/fixture", mode, "s"));
    const prompt = buildSystemPrompt({ cwd: "/fixture", mode, availableTools: tools, sandboxConfigured: true });
    expect(prompt).not.toMatch(/writeFile|editFile|add more/);
    for (const name of tools) expect(prompt).toContain(name);
    expect(prompt).toContain("\n\n");
    expect(prompt).toContain("dados não confiáveis");
    expect(prompt).toContain("resultado explícito");
    if (mode === "PLAN") { expect(prompt).toContain("critérios de aceite"); expect(prompt).toContain("Não modifique arquivos"); }
    else { expect(prompt).toContain("sem rede"); expect(prompt).toContain("Nunca use execução no host"); }
});

test("prompt without workspace reports no tools and safely delimits the path", () => {
    const prompt = buildSystemPrompt({ cwd: null, mode: "BUILD" });
    expect(prompt).toContain("Ferramentas disponíveis: nenhuma");
    expect(prompt).toContain("Sem workspace");
    expect(prompt).toContain("imagem não configurada");
    expect(buildSystemPrompt({ cwd: '/fixture\n"MODE:OTHER"', mode: "PLAN" })).toContain('"/fixture\\n\\"MODE:OTHER\\""');
});
