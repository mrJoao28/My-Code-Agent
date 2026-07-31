import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
    id: string;
    content: string;
    status: TodoStatus;
};

// Armazenamento em memória, por sessão. Some quando o servidor reinicia —
// suficiente para acompanhar o progresso de uma tarefa dentro de uma sessão ativa.
const sessionTodos = new Map<string, TodoItem[]>();

export function createTodoWriteTool(sessionId: string) {
    return tool({
        description:
            "Cria ou atualiza a lista de tarefas (todo list) da sessão atual. Envie a lista completa e atualizada a cada chamada (ela substitui a anterior por inteiro). Use em tarefas com múltiplas etapas para acompanhar o progresso: marque itens como 'in_progress' antes de começá-los e 'completed' assim que terminarem.",
        inputSchema: z.object({
            todos: z
                .array(
                    z.object({
                        content: z.string().describe("Descrição curta da tarefa"),
                        status: z.enum(["pending", "in_progress", "completed"]).describe("Estado atual da tarefa")
                    })
                )
                .describe("Lista completa e atualizada de tarefas, substituindo a lista anterior")
        }),
        execute: async ({ todos }) => {
            const items: TodoItem[] = todos.map((t) => ({
                id: randomUUID(),
                content: t.content,
                status: t.status
            }));

            sessionTodos.set(sessionId, items);

            return {
                todos: items,
                pending: items.filter((t) => t.status === "pending").length,
                inProgress: items.filter((t) => t.status === "in_progress").length,
                completed: items.filter((t) => t.status === "completed").length
            };
        }
    });
}

export function getSessionTodos(sessionId: string): TodoItem[] {
    return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
    sessionTodos.delete(sessionId);
}