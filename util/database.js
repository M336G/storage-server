// i need to make sure this runs before anything else in the future
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "path";

import { log } from "./functions.js";

const migrationsPath = join(__dirname, "..", "data", "migrations");

async function initializeDatabase() {
    try {
        const db = new Database(join(__dirname, "..", "data", "database.db"));

        const files = await readdir(migrationsPath);
        const sqlFiles = files.filter(file => file.endsWith(".sql"));

        sqlFiles.sort((a, b) => {
            const dateA = a.substring(0, 10);
            const dateB = b.substring(0, 10);

            // Convert to Date objects
            const [dayA, monthA, yearA] = dateA.split("-").map(Number);
            const [dayB, monthB, yearB] = dateB.split("-").map(Number);

            const dateObjA = new Date(yearA, monthA - 1, dayA);
            const dateObjB = new Date(yearB, monthB - 1, dayB);

            return dateObjA - dateObjB;
        });

        let completedMigrations = 0;

        // Execute migrations order from oldest to most recent
        for (const file of sqlFiles) {
            const filePath = join(migrationsPath, file);
            const script = await Bun.file(filePath).text();

            try {
                db.exec(script);
                completedMigrations += 1;
            } catch (error) {
                log.warn(`Skipped migration ${file}: ${error.message}`);
            }
        }

        if (completedMigrations > 0) log.info(`Successfully ran ${completedMigrations} SQLite migrations`);

        db.exec("PRAGMA journal_mode = WAL;");
        log.info("Connected to SQLite");

        return db;
    } catch (error) {
        console.error("[ERROR] Error initializing SQLite database:", error); // process gets stopped before log.error is called so need to make it sync lol
        process.exit(1);
    }
}

const db = await initializeDatabase();

export { db };