import { db } from "./initializeDatabase.js";

export const DatabaseWrapper = {
	checkFileExistenceFromUUID: async (uuid) => {
		return !!db.prepare("SELECT 1 FROM storage WHERE ID = ?").get(uuid);
	},

	deleteFileFromUUID: async (uuid) => {
		const result = db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);

		if (result.changes > 0) return true;
		else throw new Error(`Could not delete "${uuid}" from the database`);
	},

	updateLastAccessFromUUID: async (uuid) => {
		const result = db
			.prepare("UPDATE storage SET accessed = ? WHERE ID = ?")
			.run(Date.now(), uuid);
		if (result.changes > 0) return true;
		throw new Error(`Could not update "${uuid}"'s last access time`);
	},

	getTotalAmountOfFiles: async () => {
		const row = db.prepare("SELECT COUNT(*) as count FROM storage").get();
		if (row?.count !== undefined) return row.count;
		throw new Error("Could not get the total amount of files in the database");
	},

	getTotalSize: async () => {
		const row = db.prepare("SELECT SUM(size) as size FROM storage").get();
		return row?.size ?? 0;
	},

	getFileMetadataFromUUID: async (uuid) => {
		const metadata = db
			.prepare(
				"SELECT ID, hash, compressedHash, size, compressed, expires, accessed, timestamp FROM storage WHERE ID = ?",
			)
			.get(uuid);
		if (metadata) return metadata;
		throw new Error(`Could not get "${uuid}"'s metadata`);
	},

	getFileMetadataFromHash: async (hash) => {
		const metadata = db
			.prepare(
				"SELECT ID, hash, compressedHash, size, compressed, expires, accessed, timestamp FROM storage WHERE hash = ? ORDER BY timestamp DESC LIMIT 1",
			)
			.get(hash);
		if (metadata) return metadata;
		throw new Error(`Could not get "${hash}"'s metadata`);
	},

	checkFileExistenceFromHash: async (hash) => {
		return !!db.prepare("SELECT 1 FROM storage WHERE hash = ?").get(hash);
	},

	addFile: async (uuid, hash, compressedHash, size, expires, compressed) => {
		const result = db
			.prepare(
				"INSERT INTO storage (ID, hash, compressedHash, timestamp, size, expires, compressed) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(uuid, hash, compressedHash, Date.now(), size, expires, compressed);
		if (result.changes > 0) return true;
		throw new Error("Could not add a file to the database");
	},

	getAllFileIDs: async () => {
		const files = db.prepare("SELECT ID FROM storage").all();
		if (files) return files;
		throw new Error("Could not fetch all file IDs from the database");
	},

	getExpiredFiles: async (timestamp, unaccessedBeforeDeletion) => {
		const expiredFiles = db
			.prepare(
				"SELECT ID FROM storage WHERE (expires IS NOT NULL AND expires < ?) OR (accessed IS NOT NULL AND accessed < ?) OR (accessed IS NULL AND timestamp < ?)",
			)
			.all(timestamp, unaccessedBeforeDeletion, unaccessedBeforeDeletion);
		if (expiredFiles) return expiredFiles;
		throw new Error("Could not fetch expired files from the database");
	},

	deleteExpiredFiles: async (timestamp, unaccessedBeforeDeletion) => {
		const result = db
			.prepare(
				"DELETE FROM storage WHERE (expires IS NOT NULL AND expires < ?) OR (accessed IS NOT NULL AND accessed < ?) OR (accessed IS NULL AND timestamp < ?)",
			)
			.run(timestamp, unaccessedBeforeDeletion, unaccessedBeforeDeletion);
		if (result.changes > 0) return true;
		throw new Error("Could not delete expired files from the database");
	},

	getFileIDsWithoutHash: async () => {
		const files = db.prepare("SELECT ID FROM storage WHERE hash IS NULL").all();
		if (files) return files;
		throw new Error("Could not fetch files without hash from the database");
	},

	updateHashFromUUID: async (hash, uuid) => {
		const result = db
			.prepare("UPDATE storage SET hash = ? WHERE ID = ?")
			.run(hash, uuid);
		if (result.changes > 0) return true;
		throw new Error(`Could not update "${uuid}"'s hash`);
	},
};