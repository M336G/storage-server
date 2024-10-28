require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const validator = require("validator");
const zlib = require("zlib");
const fs = require("fs");
const Database = require("better-sqlite3");
const axios = require("axios");

const { log } = require(path.join(__dirname, "util", "functions.js"));
const { storagePath, maxStorageSize, enableCompression } = require(path.join(__dirname, "config.json"));
const { version } = require(path.join(__dirname, "package.json"));

const PORT = process.env.PORT ? process.env.PORT : 3033;
const TOKEN = process.env.TOKEN;
if (!TOKEN) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats")

let db;
try {
    db = new Database(path.join(__dirname, "data", "database.db"));
    const initScript = fs.readFileSync(path.join(__dirname, "data", "database.sql"), "utf8");
    db.exec(initScript);
    log.info("Connected to SQLite and initialized tables if they didn't exist");
} catch (error) {
    log.error("Error initializing SQLite database:", error.message);
    process.exit(1);
}

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

app.get("/file/:uuid", async (req, res) => {
    try {
        let { uuid } = req.params;
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "You can't just download the server!" }); else return }
        if (!validator.isUUID(uuid, 4)) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Invalid UUID" }); else return }

        const fileData = db.prepare("SELECT 1 as 'exists', expires, compressed FROM storage WHERE ID = ?").get(uuid);
        // Check if the file exists
        if (!fileData) { if (!res.headersSent) return res.status(404).json({ success: false, cause: "This file doesn't exist!" }); else return }

        const now = Date.now();
        const expires = fileData.expires ? parseInt(fileData.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        // If expired delete from database and storage
        if (expires && maxAge <= 0) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await fs.promises.unlink(path.join(storagePath, uuid));
            log.info(`Deleted expired file (${uuid})`);
            if (!res.headersSent) res.status(404).json({ success: false, cause: "This file doesn't exist!" });
            return;
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
            if (!res.headersSent) return res.status(500).send({ success: false, cause: "Internal Server Error" }); else return
        });
    } catch (error) {
        log.error("Error while trying to return file:", error);
        if (!res.headersSent) res.status(500).send({ success: false, cause: "Internal Server Error" });
        return;
    }
});

app.use(express.json({ limit: "2gb" }));

app.get("/info/:uuid", async (req, res) => {
    try {
        let { uuid } = req.params;
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "You can't just fetch the server!" }); else return }
        if (!validator.isUUID(uuid, 4)) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Invalid UUID" }); else return }

        const file = db.prepare("SELECT size, expires, timestamp FROM storage WHERE ID = ?").get(uuid);
        // Check if the file exists
        if (!file) { if (!res.headersSent) return res.status(404).json({ success: false, cause: "This file doesn't exist!" }); else return }
        
        // If expired delete from database and storage
        const now = Date.now();
        const expires = file.expires ? parseInt(file.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        if (file.expires && maxAge <= 0) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await fs.promises.unlink(path.join(storagePath, uuid));
            log.info(`Deleted expired file (${uuid})`);
            if (!res.headersSent) res.status(404).json({ success: false, cause: "This file doesn't exist!" });
            return;
        }

        res.set("Cache-Control", `public, max-age=${maxAge / 1000}, immutable`); // Set Cache-Control header

        if (!res.headersSent) res.status(200).json({ success: true, uuid, size: file.size, expires: file.expires, timestamp: file.timestamp });
        return;
    } catch (error) {
        log.error("Error while trying to return file info:", error);
        if (!res.headersSent) res.status(500).send({ success: false, cause: "Internal Server Error" });
        return;
    }
});

app.delete("/file/:uuid", checkToken, async (req, res) => {
    try {
        let { uuid } = req.params;
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "You can't just delete the server!" }); else return }
        if (!validator.isUUID(uuid, 4)) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Invalid UUID" }); else return }

        const fileExist = db.prepare("SELECT 1 FROM storage WHERE ID = ?").get(uuid);
        // Check if the file exists
        if (!fileExist) { if (!res.headersSent) return res.status(404).json({ success: false, cause: "This file doesn't exist!" }); else return }

        // Delete the file
        db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
        await fs.promises.unlink(path.join(storagePath, uuid));
        log.info(`Deleted file (${uuid})`);
        if (!res.headersSent) res.status(200).json({ success: true, uuid });
        return;
    } catch (error) {
        log.error("Error while trying to return file:", error);
        if (!res.headersSent) res.status(500).send({ success: false, cause: "Internal Server Error" });
        return;
    }
});

app.get("/ping", checkToken, async (req, res) => {
    try {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");

        if (!res.headersSent) res.status(200).json({ timestamp: Date.now() });
        return;
    }
    catch (error) {
        log.error("Error while trying to ping (somehow):", error);
        if (!res.headersSent) res.status(500).send({ success: false, cause: "Internal Server Error" });
        return;
    }
});

app.post("/upload", checkToken, async (req, res) => {
    try {
        let { file, link, expires } = req.body;
        if (link) link = decodeURIComponent(link, "base64url").replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, "");
        if (!file && !link) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Please atleast send a file or a link!" }); else return }
        if (expires && typeof expires !== "number") { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Make sure that the expires parameter is an integer" }); else return }
        if (expires && expires <= Date.now()) { if (!res.headersSent) return res.status(400).send({ success: false, cause: "Expiry timestamp must be above the current epoch timestamp" }); else return }

        // Check if the file is encoded in base64 first
        if (file && !validator.isBase64(file)) { if (!res.headersSent) return res.status(422).send({ success: false, cause: "Please send a base64 encoded file" }); else return }
        if (link && !validator.isURL(link)) { if (!res.headersSent) return res.status(422).send({ success: false, cause: "Please send a valid URL" }); else return }
        if (file) file = Buffer.from(file, "base64");

        if (link) {
            try {
                file = await axios.get(link, { responseType: "arraybuffer", headers: { "User-Agent": `StorageServer/${version}` } });
                file = Buffer.from(file.data, "binary");
            } catch (error) {
                if (error.response && error.response.status === 404) { if (!res.headersSent) return res.status(404).send({ success: false, cause: "The link you provided doesn't exist" }); else return }
                log.error("Error while trying to fetch a file:", error);
                if (!res.headersSent) res.status(500).send({ success: false, cause: "An error occured while trying to fetch this file" });
                return;
            }
        }

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
            if (!file) { if (!res.headersSent) return res.status(500).send({ success: false, cause: "Internal Server Error" }); else return }
        }

        const size = Buffer.byteLength(file);
        if (maxStorageSize) {
            const totalSize = db.prepare("SELECT SUM(size) AS totalSize FROM storage").get().totalSize;
            // Convert from gigabytes to bytes
            console.log(totalSize)
            if (totalSize >= maxStorageSize * 1073741824 || totalSize + size >= maxStorageSize * 1073741824) { if (!res.headersSent) return res.status(507).send({ success: false, cause: "This storage has hit its total size limit!" }); else return }
        }

        const timestamp = Date.now();
        const uuid = crypto.randomUUID();

        await fs.promises.writeFile(path.join(storagePath, uuid), file);
        db.prepare(
            `INSERT INTO storage (ID, size, compressed, expires, timestamp) 
             VALUES (?, ?, ?, ?, ?)`
        ).run(uuid, size, enableCompression ? 1 : 0, expires, timestamp);

        log.info(`New file added (${uuid})`);
        res.status(200).send({ success: true, uuid, size, expires, timestamp });
    } catch (error) {
        log.error("Error while trying to upload a file:", error);
        if (!res.headersSent) res.status(500).send({ success: false, cause: "Internal Server Error" });
        return;
    }
});

app.listen(PORT, async () => { log.info(`Server is now running on ${PORT}`) });

function checkToken(req, res, next) {
    if (!TOKEN) return next();

    const token = req.headers.authorization;
    if (token && token === `Bearer ${TOKEN}`) return next();
    else { if (!res.headersSent) res.status(401).json({ success: false, cause: "Unauthorized" }); return };
}

const checkExpiredFiles = () => {
    const now = Date.now();
    const expiredFiles = db.prepare("SELECT ID FROM storage WHERE expires IS NOT NULL AND expires < ?").all(now);
    expiredFiles.forEach(row => {
        const uuid = row.ID;
        db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
        fs.promises.unlink(path.join(storagePath, uuid)).then(() => {
            log.info(`Deleted expired file (${uuid})`);
        }).catch((error) => {
            log.error("Error deleting expired file from storage:", error);
        });
    });
};

setInterval(checkExpiredFiles, 1800000); // Check for expired files every 30 minutes

process.on("unhandledRejection", (reason, promise) => {
    log.error(`Unhandled rejection at ${promise}:`, reason);
});

process.on("uncaughtException", (error) => {
    log.error(`Uncaught exception:`, error);
});