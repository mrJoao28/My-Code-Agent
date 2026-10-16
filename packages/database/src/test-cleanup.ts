import { rm } from "node:fs/promises";

// O driver nativo do libsql libera statements pelo GC no Windows.
// Aguarda finalizadores sem suprimir uma falha persistente de limpeza.
export async function removeTestDatabase(home: string) {
    for (let attempt = 0; ; attempt++) {
        Bun.gc(true);
        await Bun.sleep(100);
        try { await rm(home, { recursive: true, force: true }); return; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 10) throw error;
        }
    }
}
