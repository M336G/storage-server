import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./functions.js";

const migrationsPath = join(__dirname, "..", "data", "migrations");

function initializeDatabase() {
    try {
        const db = new Database(join(__dirname, "..", "data", "database.db"));

        db.exec(`CREATE TABLE IF NOT EXISTS migrations (
                    "date" VARCHAR(8) NOT NULL UNIQUE,
                    "timestamp" INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY("date")
                )`
        );

        const files = readdirSync(migrationsPath);
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
            const migrationDate = file.substring(0, 10);

            const migrationExists = db.prepare("SELECT 1 FROM migrations WHERE date = ?").get(migrationDate);
            if (!migrationExists) {
                const filePath = join(migrationsPath, file);
                const script = readFileSync(filePath, "utf-8");
    
                try {
                    db.exec(script);
                    db.prepare("INSERT INTO migrations (date, timestamp) VALUES (?, ?)").run(migrationDate, Date.now());
                    completedMigrations += 1;
                } catch (error) {
                    log.warn(`Skipped migration ${file}: ${error.message}`);
                }
            }
        }

        if (completedMigrations > 0) log.info(`Successfully ran ${completedMigrations} SQLite migrations`);

        db.exec("PRAGMA journal_mode = WAL;");
        log.info("Connected to SQLite");

        return db;
    } catch (error) {
        log.error("Error initializing SQLite database:", error);
        process.exit(1);
    }
}

const db = initializeDatabase();

export { db };