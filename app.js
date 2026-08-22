import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { deflate, gzip } from "node:zlib";
import { fileTypeFromBuffer } from "file-type";
import { isURL, isUUID } from "validator";
import { DatabaseWrapper } from "./util/database.js";
import {
	checkExpiredFiles,
	checkHashes,
	checkInvalidFiles,
	checkToken,
	checkUnknownFiles,
	cleanExpiredIPEntries,
	getHashFromBuffer,
	log,
	rateLimit,
} from "./util/functions.js";
import { RegexCheck } from "./util/security.js";
import { contentEncoding, Headers } from "./util/utilities.js";

global.serverToken = process.env.TOKEN;
global.serverPort = Number(process.env.PORT) || 3033;
global.serverHostname = process.env.HOSTNAME || hostname();
global.maxStorageBytes = process.env.MAX_STORAGE_SIZE
	? Number(process.env.MAX_STORAGE_SIZE) * 1024 * 1024 * 1024
	: null; // Convert from gigabytes to bytes
global.maximumUploadSize = process.env.MAXIMUM_UPLOAD_SIZE
	? Number(process.env.MAXIMUM_UPLOAD_SIZE) * 1024 * 1024 * 1024
	: undefined;
global.storagePath = process.env.STORAGE_PATH
	? isAbsolute(process.env.STORAGE_PATH)
		? process.env.STORAGE_PATH
		: join(process.cwd(), process.env.STORAGE_PATH)
	: join(process.cwd(), "data", "storage");
global.unaccessedMillisecondsBeforeDeletion = process.env
	.UNACCESSED_DAYS_BEFORE_DELETION
	? Number(process.env.UNACCESSED_DAYS_BEFORE_DELETION) * 24 * 60 * 60 * 1000
	: undefined;

if (!existsSync(global.storagePath))
	mkdirSync(global.storagePath, { recursive: true, force: true });

if (!global.serverToken)
	log.warn(
		"The server is currently running without any token. It is extremely recommended to set one to avoid potential threats",
	);
else if (global.serverToken === "AAAABBBBCCCCDDDD")
	log.warn(
		"The server is currently running with the example token. It is extremely recommmended to set one secured!",
	);

// Table kept in memory to follow requests
global.requestCounts = new Map();

global.rateLimitWindowMs = 60 * 1000; // 1 minute
global.maxRequestsPerWindow = process.env.RATE_LIMIT; // Maximum amount of requests per minute

const server = Bun.serve({
	port: global.serverPort,
	maxRequestBodySize: global.maximumUploadSize,
	development: process.argv.includes("--dev") || false,

	routes: {
		"/": Response.redirect("/info/", 307),

		// Ping the server
		"/ping": {
			OPTIONS: async () => {
				return new Response(null, { status: 204, headers: Headers.ping });
			},
			GET: async () => {
				return Response.json(
					{ success: true, timestamp: Date.now() },
					{ headers: Headers.ping },
				);
			},
		},

		"/file/:uuid": {
			OPTIONS: async () => {
				return new Response(null, {
					status: 204,
					headers: {
						...Headers.file,
						"Access-Control-Allow-Headers": "Authorization",
					},
				});
			},
			// Get info about the file
			HEAD: async (req) => {
				try {
					const uuid = req.params.uuid;

					// Check if UUID is valid
					if (
						!uuid ||
						!isUUID(uuid, 4) ||
						uuid.includes("..") ||
						uuid.includes("/")
					)
						return new Response(null, { status: 400, headers: Headers.file });

					// Check if file exists in the database
					if (!(await DatabaseWrapper.checkFileExistenceFromUUID(uuid)))
						return new Response(null, { status: 404, headers: Headers.file });

					const filePath = join(global.storagePath, uuid);

					// Check if the file exists locally
					if (!(await Bun.file(filePath).exists())) {
						await DatabaseWrapper.deleteFileFromUUID(uuid); // Clean up the database if file is missing
						return new Response(null, { status: 404, headers: Headers.file });
					}

					const fileMetadata =
						await DatabaseWrapper.getFileMetadataFromUUID(uuid);

					const now = Date.now();
					const expires = fileMetadata.expires
						? parseInt(fileMetadata.expires, 10)
						: null;
					const maxAge = expires
						? expires > now
							? expires - now
							: -1
						: 2592000000; // Default to 30 days

					// If the file is expired, delete it completely instead of returning info about it
					if (expires && maxAge <= 0) {
						await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
						await unlink(filePath); // Delete the file itself
						log.info(`Deleted expired file (${uuid})`);
						return new Response(null, { status: 404, headers: Headers.file });
					}

					const file = await Bun.file(filePath).bytes();

					const headers = {
						...Headers.file,

						"Content-Length": file.byteLength,
						"Cache-Control": `public, max-age=${maxAge / 1000}, immutable`,
					};

					if (fileMetadata.compressed >= 1)
						headers["Content-Encoding"] =
							contentEncoding[fileMetadata.compressed];

					const fileType =
						fileMetadata.compressed < 1
							? (await fileTypeFromBuffer(file))?.mime
							: null;
					if (fileType) headers["Content-Type"] = fileType;

					return new Response(null, { status: 200, headers });
				} catch (error) {
					log.error(`HEAD /file error: ${error?.stack || error}`);
					return new Response(null, { status: 500, headers: Headers.file });
				}
			},

			// Get a file from the server
			GET: async (req) => {
				try {
					if (!(await rateLimit(req)))
						return new Response("Rate limited", {
							status: 429,
							headers: Headers.file,
						});

					const uuid = req.params.uuid;
					if (!uuid)
						return new Response("No file UUID supplied!", {
							status: 400,
							headers: Headers.file,
						});
					if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/"))
						return new Response("Invalid UUID", {
							status: 400,
							headers: Headers.file,
						});

					if (!(await DatabaseWrapper.checkFileExistenceFromUUID(uuid)))
						return new Response("This file doesn't exist!", {
							status: 404,
							headers: Headers.file,
						});

					const filePath = join(global.storagePath, uuid);

					// If it doesn't exist locally delete it from the database
					if (!(await Bun.file(filePath).exists())) {
						await DatabaseWrapper.deleteFileFromUUID(uuid);
						return new Response("This file doesn't exist!", {
							status: 404,
							headers: Headers.file,
						});
					}

					const fileMetadata =
						await DatabaseWrapper.getFileMetadataFromUUID(uuid);

					const now = Date.now();
					const expires = fileMetadata.expires
						? parseInt(fileMetadata.expires, 10)
						: null;
					const maxAge = expires
						? expires > now
							? expires - now
							: -1
						: 30 * 24 * 60 * 60 * 1000; // Default to 30 days

					// If the file is expired, delete it completely instead of returning it
					if (expires && maxAge <= 0) {
						await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
						await unlink(filePath); // Delete the file itself
						log.info(`Deleted expired file (${uuid})`);
						return new Response("This file doesn't exist!", {
							status: 404,
							headers: Headers.file,
						});
					}

					DatabaseWrapper.updateLastAccessFromUUID(uuid); // Update the last access time

					const bunFile = Bun.file(filePath);

					const responseHeaders = {
						...Headers.file,

						"Content-Length": fileMetadata.size,
						"Cache-Control": `public, max-age=${maxAge / 1000}, immutable`,
					};
					if (fileMetadata.compressed >= 1)
						responseHeaders["Content-Encoding"] =
							contentEncoding[fileMetadata.compressed];

					const fileType =
						fileMetadata.compressed < 1
							? (await fileTypeFromBuffer(await bunFile.bytes()))?.mime
							: null;
					if (fileType) responseHeaders["Content-Type"] = fileType;

					// Stream the file directly. No manual PassThrough/pipeline needed:
					// Bun.file().stream() already yields a ReadableStream that Response accepts,
					// and letting a client abort mid-download just cancels the stream instead of
					// throwing an unhandled/uncaught exception that could crash the whole server.
					return new Response(bunFile.stream(), { headers: responseHeaders });
				} catch (error) {
					// A stream/network hiccup on ONE request must never take down the whole process.
					log.error(`GET /file error: ${error?.stack || error}`);
					return new Response("Internal Server Error", {
						status: 500,
						headers: Headers.file,
					});
				}
			},

			// Delete a file from the server
			DELETE: async (req) => {
				try {
					if (!(await rateLimit(req)))
						return Response.json(
							{ success: false, cause: `Rate limited` },
							{
								status: 429,
								headers: {
									...Headers.file,
									"Access-Control-Allow-Headers": "Authorization",
								},
							},
						);
					if (!(await checkToken(req.headers.get("Authorization"))))
						return Response.json(
							{ success: false, cause: "Unauthorized" },
							{
								status: 401,
								headers: {
									...Headers.file,
									"Access-Control-Allow-Headers": "Authorization",
								},
							},
						);

					const uuid = req.params.uuid;
					if (!uuid)
						return Response.json(
							{
								success: false,
								cause: "You can't just use that on the whole server!",
							},
							{
								status: 400,
								headers: {
									...Headers.file,
									"Access-Control-Allow-Headers": "Authorization",
								},
							},
						);
					if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/"))
						return Response.json(
							{ success: false, cause: "Invalid UUID" },
							{
								status: 400,
								headers: {
									...Headers.file,
									"Access-Control-Allow-Headers": "Authorization",
								},
							},
						);

					if (!(await DatabaseWrapper.checkFileExistenceFromUUID(uuid)))
						return Response.json(
							{ success: false, cause: "This file doesn't exist!" },
							{
								status: 404,
								headers: {
									...Headers.file,
									"Access-Control-Allow-Headers": "Authorization",
								},
							},
						);

					await DatabaseWrapper.deleteFileFromUUID(uuid);
					await unlink(join(global.storagePath, uuid));

					log.info(`Deleted file (${uuid})`);
					return Response.json(
						{ success: true, uuid },
						{
							status: 200,
							headers: {
								...Headers.file,
								"Access-Control-Allow-Headers": "Authorization",
							},
						},
					);
				} catch (error) {
					log.error(`DELETE /file error: ${error?.stack || error}`);
					return Response.json(
						{ success: false, cause: "Internal Server Error" },
						{
							status: 500,
							headers: {
								...Headers.file,
								"Access-Control-Allow-Headers": "Authorization",
							},
						},
					);
				}
			},
		},

		"/info": Response.redirect("/info/", 301),

		// Get info about the server
		"/info/": {
			OPTIONS: async () => {
				return new Response(null, { status: 204, headers: Headers.info });
			},
			GET: async () => {
				try {
					return Response.json(
						{
							success: true,
							name: global.serverHostname,
							version: global.serverVersion,
							start: global.startupTime,
							count: await DatabaseWrapper.getTotalAmountOfFiles(),
							size: await DatabaseWrapper.getTotalSize(),
							maxUploadSize: global.maximumUploadSize,
							maxSize: global.maxStorageBytes,
							maxUnaccessedTime: global.unaccessedMillisecondsBeforeDeletion,
						},
						{ headers: Headers.info },
					);
				} catch (error) {
					log.error(`GET /info error: ${error?.stack || error}`);
					return Response.json(
						{ success: false, cause: "Internal Server Error" },
						{ status: 500, headers: Headers.info },
					);
				}
			},
		},

		// Get info about a specific file
		"/info/:uuid": {
			OPTIONS: async () => {
				return new Response(null, { status: 204, headers: Headers.info });
			},
			GET: async (req) => {
				try {
					const uuid = req.params.uuid;
					if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/"))
						return Response.json(
							{ success: false, cause: "Invalid UUID" },
							{ status: 400, headers: Headers.info },
						);

					if (!(await DatabaseWrapper.checkFileExistenceFromUUID(uuid)))
						return Response.json(
							{ success: false, cause: "This file doesn't exist!" },
							{ status: 404, headers: Headers.info },
						);

					const fileMetadata =
						await DatabaseWrapper.getFileMetadataFromUUID(uuid);

					const now = Date.now();
					const expires = fileMetadata.expires
						? parseInt(fileMetadata.expires, 10)
						: null;
					const maxAge = expires
						? expires > now
							? expires - now
							: -1
						: 30 * 24 * 60 * 60 * 1000; // Default to 30 days

					// If the file is expired, delete it completely instead of returning info about it
					if (expires && maxAge <= 0) {
						await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
						await unlink(join(global.storagePath, uuid)); // Delete the file itself
						log.info(`Deleted expired file (${uuid})`);
						return Response.json(
							{ success: false, cause: "This file doesn't exist!" },
							{ status: 404, headers: Headers.info },
						);
					}

					return Response.json(
						{
							success: true,
							uuid,
							hash: fileMetadata.hash,
							compressedHash: fileMetadata.compressedHash,
							compressionType: contentEncoding[fileMetadata.compressed],
							size: fileMetadata.size,
							expires: fileMetadata.expires,
							accessed: fileMetadata.accessed,
							timestamp: fileMetadata.timestamp,
						},
						{ headers: Headers.info },
					);
				} catch (error) {
					log.error(`GET /info/:uuid error: ${error?.stack || error}`);
					return Response.json(
						{ success: false, cause: "Internal Server Error" },
						{ status: 500, headers: Headers.info },
					);
				}
			},
		},

		// Upload a new file on the server
		"/upload": {
			OPTIONS: async () => {
				return new Response(null, { status: 204, headers: Headers.upload });
			},
			POST: async (req) => {
				try {
					const url = new URL(req.url);
					let link = url.searchParams.get("link");
					const expires = url.searchParams.get("expires");

					let file = await req.bytes();

					if (!(await rateLimit(req)))
						return Response.json(
							{ success: false, cause: "Rate limited" },
							{ status: 429, headers: Headers.upload },
						);
					if (!(await checkToken(req.headers.get("Authorization"))))
						return Response.json(
							{ success: false, cause: "Unauthorized" },
							{ status: 401, headers: Headers.upload },
						);

					if (file.byteLength === 0 && !link)
						return Response.json(
							{
								success: false,
								cause: "Please at least send a file or a link!",
							},
							{ status: 400, headers: Headers.upload },
						);
					if (file.byteLength !== 0 && link)
						return Response.json(
							{
								success: false,
								cause: "Please only supply either a file or a link!",
							},
							{ status: 400, headers: Headers.upload },
						);

					if (link) link = decodeURI(link);
					if (link && (!isURL(link) || !(await RegexCheck.URL(link))))
						return Response.json(
							{ success: false, cause: "Please send a valid URL" },
							{ status: 422, headers: Headers.upload },
						);

					if (expires && typeof expires !== "number")
						return Response.json(
							{
								success: false,
								cause: "Make sure that the expires parameter is an integer",
							},
							{ status: 422, headers: Headers.upload },
						);
					if (expires && expires <= Date.now())
						return Response.json(
							{
								success: false,
								cause:
									"Expiry timestamp must be above the current epoch timestamp (in milliseconds)",
							},
							{ status: 422, headers: Headers.upload },
						);

					if (link) {
						let response;
						try {
							response = await fetch(link, {
								headers: {
									"User-Agent": `StorageServer/${global.serverVersion}`,
								},
							});
						} catch (fetchError) {
							log.error(
								`Failed to fetch file from URL: ${fetchError?.stack || fetchError}`,
							);
							return Response.json(
								{
									success: false,
									cause: "Failed to fetch file from the supplied URL",
								},
								{ status: 422, headers: Headers.upload },
							);
						}
						if (!response?.ok)
							return Response.json(
								{
									success: false,
									cause: `Failed to fetch file from URL with code ${response.status}: ${response.statusText}`,
								},
								{ status: 422, headers: Headers.upload },
							);

						file = await response.bytes();
						if (file.byteLength === 0)
							return Response.json(
								{
									success: false,
									cause: "The downloaded file from the supplied URL is empty!",
								},
								{ status: 422, headers: Headers.upload },
							);
					}

					const hash = await getHashFromBuffer(file);

					if (await DatabaseWrapper.checkFileExistenceFromHash(hash)) {
						const fileMetadata =
							await DatabaseWrapper.getFileMetadataFromHash(hash);
						return Response.json(
							{
								success: true,
								uuid: fileMetadata.ID,
								hash,
								compressedHash: fileMetadata.compressedHash,
								message: "This file already exists!",
							},
							{ headers: Headers.upload },
						);
					}

					// Compression stuff
					const compressed =
						Number(process.env.COMPRESSION_ALGORITHM) >= 1 &&
						Number(process.env.COMPRESSION_ALGORITHM) <= 2
							? Number(process.env.COMPRESSION_ALGORITHM) >= 1 &&
								Number(process.env.COMPRESSION_ALGORITHM)
							: 0;

					if (compressed >= 1) {
						const compressionLevel = Number(process.env.COMPRESSION_LEVEL)
							? Number(process.env.COMPRESSION_LEVEL)
							: null;

						switch (compressed) {
							case 1:
								file = await promisify(deflate)(file, {
									level:
										compressionLevel >= 1 && compressionLevel <= 9
											? compressionLevel
											: undefined,
								});
								break;
							case 2:
								file = await promisify(gzip)(file, {
									level:
										compressionLevel >= 1 && compressionLevel <= 9
											? compressionLevel
											: undefined,
								});
								break;
							default:
								return Response.json(
									{
										success: false,
										cause: "Unsupported compression algorithm",
									},
									{ status: 500, headers: Headers.upload },
								);
						}
					}

					if (!file || file.byteLength === 0)
						return Response.json(
							{ success: false, cause: "File buffer is null or zero bytes" },
							{ status: 500, headers: Headers.upload },
						);

					if (
						global.maxStorageBytes &&
						(await DatabaseWrapper.getTotalSize()) + file.length >
							global.maxStorageBytes
					)
						return Response.json(
							{
								success: false,
								cause: "This server cannot store any more files!",
							},
							{ status: 500, headers: Headers.upload },
						);

					let uuid = crypto.randomUUID();
					while (await DatabaseWrapper.checkFileExistenceFromUUID(uuid)) {
						uuid = crypto.randomUUID();
					}

					const compressedHash =
						compressed >= 1 ? await getHashFromBuffer(file) : null;

					await Bun.write(join(global.storagePath, uuid), file);
					await DatabaseWrapper.addFile(
						uuid,
						hash,
						compressedHash,
						file.length,
						expires,
						compressed,
					);

					log.info(`New file added (${uuid})`);
					return Response.json(
						{ success: true, uuid, hash, compressedHash },
						{ status: 201, headers: Headers.upload },
					);
				} catch (error) {
					log.error(`POST /upload error: ${error?.stack || error}`);
					return Response.json(
						{ success: false, cause: "Internal Server Error" },
						{ status: 500, headers: Headers.upload },
					);
				}
			},
		},

		// If the endpoint is not found
		"/*": Response.json(
			{ success: false, cause: "Not Found" },
			{ status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
		),
	},

	error(error) {
		log.error(`${error?.stack || error}`);
		return Response.json(
			{ success: false, cause: "Internal Server Error" },
			{ status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
		);
	},
});

global.startupTime = Date.now();
log.info(`Server is now running on ${server.url}`);

(async () => {
	setInterval(cleanExpiredIPEntries, 60_000); // Check for expired IP entries every minute

	await checkInvalidFiles();
	setInterval(checkInvalidFiles, 86_400_000); // Check for invalid files every day

	await checkUnknownFiles(); // Check for files that are in the storage path but not in the database
	setInterval(checkUnknownFiles, 86_400_000); // Check for unknown files every day

	await checkExpiredFiles();
	setInterval(checkExpiredFiles, 1_800_000); // Check for expired/(old) unaccessed files every 30 minutes

	await checkHashes(); // Check for files that haven't gotten an hash on startup
})();

// NOTE: these two handlers used to call server.stop() + process.exit(1) on ANY
// uncaught error, including harmless client-side stream aborts (ECONNRESET) that
// happen naturally when a downstream app cancels a download mid-stream. That
// caused the whole server (and every other in-flight request) to be killed,
// which is what was producing the cascading ECONNRESET errors in your logs.
// Now every route has its own try/catch, so only truly unexpected/fatal errors
// should reach here. Keep the process-killing behaviour, but log clearly so you
// can tell a genuine crash apart from a request-level error.
process.on("unhandledRejection", async (reason, _promise) => {
	await log.fatal(reason);
	await server.stop();
	process.exit(1);
});

process.on("uncaughtException", async (error) => {
	await log.fatal(error);
	await server.stop();
	process.exit(1);
});
