require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const validator = require("validator");
const zlib = require("zlib");
const fs = require("fs");
const { Database } = require("sqlite3").verbose();

const { log } = require(path.join(__dirname, "util", "functions.js"));
const { storagePath, enableCompression } = require(path.join(__dirname, "config.json"));

const PORT = process.env.PORT ? process.env.PORT : 3033;
const TOKEN = process.env.TOKEN;
if (!TOKEN) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats")

const db = new Database(path.join(__dirname, "data", "database.db"), async (error) => {
    if (error) {
        log.error("Error opening SQLite:", error.message);
    } else {
        log.info("Connected to SQLite");
        try {
            db.exec(await fs.promises.readFile(path.join(__dirname, "data", "database.sql"), "utf8"), async (error) => { // Execute SQL script
                if (error) {
                    await log.error("Error executing SQL script:", error.message);
                    return process.exit(1);
                } else {
                    log.info("SQLite tables have been created or already exist");
                }
            });
        } catch (error) {
            log.error("Error executing SQL script:", error.message);
        }
    }
});

const app = express();

if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY); // Number of proxies between user and server

// Rate limiting
if (process.env.RATE_LIMIT) {
    app.use(
        require("express-rate-limit").rateLimit({
        windowMs: 60 * 1000, // 1 minute
        limit: process.env.RATE_LIMIT,
        message: "Temporarily rate limited, please try again later."
    }));
}

app.get("/files/:uuid", checkToken, async (req, res) => {
    try {
        let { uuid } = req.params;
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");
        
        if (!uuid) return res.status(400).send({ success: false, cause: "You can't just download the server!" });
        if (!validator.isUUID(uuid, 4)) return res.status(400).send({ success: false, cause: "Invalid UUID" });

        const fileData = await new Promise((resolve, reject) => {
            db.get("SELECT 1 as \"exists\", expires, compressed FROM storage WHERE ID = ?", [uuid], (error, row) => {
                if (error) {
                    log.error("Error while trying to check for file existence:", error);
                    return res.status(500).send({ success: false, cause: "Internal Server Error" });
                }
                resolve(row);
            });
        });
        // Check if the file exists
        if (!fileData) return res.status(404).json({ success: false, cause: "This file doesn't exist!" });

        const now = Date.now();
        const expires = fileData.expires ? parseInt(fileData.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        // If expired delete from database and storage
        if (expires && maxAge <= 0) {
            return db.run("DELETE FROM storage WHERE ID = ?", [uuid], async (error) => {
                if (error) {
                    log.error("Error deleting expired file from database:", error);
                    return res.status(500).json({ success: false, cause: "Internal Server Error" });
                }
                
                // Remove the file from storage
                await fs.promises.unlink(path.join(storagePath, uuid), (error) => {
                    if (error) {
                        log.error("Error deleting expired file from storage:", error);
                        return res.status(500).json({ success: false, cause: "Internal Server Error" });
                    }
                    
                    log.info(`Deleted expired file (${uuid})`);
                    return res.status(404).json({ success: false, cause: "This file doesn't exist!" });
                });
            });
        }

        // Read the file from storage
        const fileStream = fs.createReadStream(path.join(storagePath, uuid));

        res.set("Cache-Control", `public, max-age=${maxAge / 1000}, immutable`); // Set Cache-Control header

        if (fileData.compressed == 1) {
            fileStream.pipe(zlib.createInflate()).pipe(res);
        } else {
            fileStream.pipe(res);
        }

        fileStream.on("error", (error) => {
            log.error("Error while reading the file:", error);
            return res.status(500).send({ success: false, cause: "Internal Server Error" });
        });
    } catch (error) {
        log.error("Error while trying to return file:", error);
        return res.status(500).send({ success: false, cause: "Internal Server Error" });
    }
});

app.use(express.json({ limit: "2gb" }));

app.delete("/files/:uuid", checkToken, async (req, res) => {
    try {
        let { uuid } = req.params;
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");
        
        if (!uuid) return res.status(400).send({ success: false, cause: "You can't just delete the server!" });
        if (!validator.isUUID(uuid, 4)) return res.status(400).send({ success: false, cause: "Invalid UUID" });

        const fileData = await new Promise((resolve, reject) => {
            db.get("SELECT 1 as \"exists\" FROM storage WHERE ID = ?", [uuid], (error, row) => {
                if (error) {
                    log.error("Error while trying to check for file existence:", error);
                    return res.status(500).send({ success: false, cause: "Internal Server Error" });
                }
                resolve(row);
            });
        });
        // Check if the file exists
        if (!fileData) return res.status(404).json({ success: false, cause: "This file doesn't exist!" });

        // Delete the file
        return db.run("DELETE FROM storage WHERE ID = ?", [uuid], async (error) => {
            if (error) {
                log.error("Error deleting file from database:", error);
                return res.status(500).json({ success: false, cause: "Internal Server Error" });
            }
                
            // Remove the file from storage
            await fs.promises.unlink(path.join(storagePath, uuid), (error) => {
                if (error) {
                    log.error("Error deleting file from storage:", error);
                    return res.status(500).json({ success: false, cause: "Internal Server Error" });
                }
                    
                log.info(`Deleted file (${uuid})`);
                return res.status(200).json({ success: true, uuid });
            });
        });
    } catch (error) {
        log.error("Error while trying to return file:", error);
        return res.status(500).send({ success: false, cause: "Internal Server Error" });
    }
});

app.get("/ping", checkToken, async (req, res) => {
    try {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
    
        res.json({ timestamp: Date.now()});
    }
    catch (error) {
        log.error("Error while trying to ping (somehow):", error);
        return res.status(500).send({ success: false, cause: "Internal Server Error" });
    }
});

app.post("/upload", checkToken, async (req, res) => {
    try {
        let { file, expires } = req.body;
        if (!file) return res.status(400).send({ success: false, cause: "Please atleast send a file" });
        if (expires && typeof expires !== "number") return res.status(400).send({ success: false, cause: "Make sure that the expires parameter is an integer" });
        if (expires && expires <= Date.now()) return res.status(400).send({ success: false, cause: "Expiry timestamp must be above the current epoch timestamp" });

        // Check if the file is encoded in base64 first
        if (!validator.isBase64(file)) return res.status(422).send({ success: false, cause: "Please send a base64 encoded file" });

        const uuid = crypto.randomUUID();
        file = Buffer.from(file, "base64");

        if (enableCompression) {
            file = await new Promise((resolve, reject) => {
                zlib.deflate(file, (error, buffer) => {
                    if (error) {
                        log.error("Error while trying to compress a file:", error);
                        resolve(null);
                    }
                    resolve(buffer);
                });
            });
            if (!file) return res.status(500).send({ success: false, cause: "Internal Server Error" });
        }

        const size = Buffer.byteLength(file);
        const timestamp = Date.now();

        await fs.promises.writeFile(path.join(storagePath, uuid), file);

        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO storage (ID, size, compressed, expires, timestamp) 
                VALUES (?, ?, ?, ?, ?)`,
                [uuid, size, enableCompression ? 1 : 0, expires, timestamp],
                (error) => {
                    if (error) {
                        log.error("Error inserting file data into SQLite:", error);
                        resolve(false);
                    } else {
                        log.info(`New file added! (${uuid})`);
                        res.status(200).send({ success: true, uuid, size, expires, timestamp });
                        resolve(true);
                    }
                }
            );
        });

    } catch (error) {
        log.error("Error while trying to upload a file:", error);
        return res.status(500).send({ success: false, cause: "Internal Server Error" });
    }
});

app.listen(PORT, async () => { log.info(`Server is now running on ${PORT}`) });

function checkToken(req, res, next) {
    if (!TOKEN) return next();

    const token = req.headers.authorization;
    if (token && token === `Bearer ${TOKEN}`) return next();

    return res.status(401).json({ success: false, cause: "Unauthorized" });
}

const checkExpiredFiles = () => {
    const now = Date.now();
    db.all("SELECT ID FROM storage WHERE expires IS NOT NULL AND expires < ?", [now], (error, rows) => {
        if (error) return log.error("Error while checking for expired files:", error);
        rows.forEach(row => {
            const uuid = row.ID;
            db.run("DELETE FROM storage WHERE ID = ?", [uuid], async (error) => {
                if (error) return log.error("Error deleting expired file from database:", error);
                await fs.promises.unlink(path.join(storagePath, uuid), (error) => {
                    if (error) {
                        log.error("Error deleting expired file from storage:", error);
                    } else {
                        log.info(`Deleted expired file (${uuid})`);
                    }
                });
            }
        );
    });
})};

setInterval(checkExpiredFiles, 1800000); // Check for expired files every 30 minutes

process.on("unhandledRejection", (reason, promise) => {
    log.error(`Unhandled rejection at ${promise}:`, reason);
});

process.on("uncaughtException", (error) => {
    log.error(`Uncaught exception:`, error);
});
