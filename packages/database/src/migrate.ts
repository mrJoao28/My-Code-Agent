import { openDatabase } from "./client";
const database = await openDatabase();
await database.close();
console.log("Banco SQLite local atualizado.");
