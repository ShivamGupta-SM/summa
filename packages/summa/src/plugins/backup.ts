// =============================================================================
// BACKUP & DISASTER RECOVERY PLUGIN -- Database backup with multiple backends
// =============================================================================
// PostgreSQL backup via pg_dump with support for local disk and S3 storage.
// Leverages event sourcing for point-in-time recovery capabilities.
// Scheduled daily backups with retention management.

import { execFile as execFileCb } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

const execFile = promisify(execFileCb);

// =============================================================================
// TYPES
// =============================================================================

export interface BackupOptions {
	/** Storage backend. Default: "local" */
	storage?: "local" | "s3";
	/** Local backup directory. Default: "./backups" */
	localPath?: string;
	/** S3 bucket name (required if storage is "s3") */
	s3Bucket?: string;
	/** S3 key prefix. Default: "summa-backups/" */
	s3Prefix?: string;
	/** AWS region. Default: "us-east-1" */
	s3Region?: string;
	/** Backup schedule interval. Default: "1d" */
	interval?: string;
	/** Retention days for old backups. Default: 30 */
	retentionDays?: number;
	/** Database connection string (overrides adapter). Required for pg_dump. */
	databaseUrl?: string;
}

export interface BackupRecord {
	id: string;
	fileName: string;
	storage: "local" | "s3";
	sizeBytes: number;
	status: "in_progress" | "completed" | "failed";
	errorMessage: string | null;
	startedAt: string;
	completedAt: string | null;
}

// =============================================================================
// RAW ROWS
// =============================================================================

interface RawBackupRow {
	id: string;
	file_name: string;
	storage: string;
	size_bytes: number | string;
	status: string;
	error_message: string | null;
	started_at: string | Date;
	completed_at: string | Date | null;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(val: string | Date | null): string | null {
	if (!val) return null;
	return val instanceof Date ? val.toISOString() : String(val);
}

function rawToBackup(row: RawBackupRow): BackupRecord {
	return {
		id: row.id,
		fileName: row.file_name,
		storage: row.storage as "local" | "s3",
		sizeBytes: Number(row.size_bytes),
		status: row.status as BackupRecord["status"],
		errorMessage: row.error_message,
		startedAt: toIso(row.started_at)!,
		completedAt: toIso(row.completed_at),
	};
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function generateFileName(schema: string): string {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, "");
	const time = now.toISOString().slice(11, 19).replace(/:/g, "");
	return `summa_${schema}_${date}_${time}.dump`;
}

// =============================================================================
// SCHEMA
// =============================================================================

const backupSchema: Record<string, TableDefinition> = {
	backup_history: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			file_name: { type: "text", notNull: true },
			storage: { type: "text", notNull: true },
			size_bytes: { type: "bigint", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'in_progress'" },
			error_message: { type: "text" },
			started_at: { type: "timestamp", notNull: true, default: "NOW()" },
			completed_at: { type: "timestamp" },
		},
		indexes: [
			{ name: "idx_backup_history_status", columns: ["status"] },
			{ name: "idx_backup_history_started", columns: ["started_at"] },
		],
	},
};

// =============================================================================
// BACKUP OPERATIONS
// =============================================================================

async function performLocalBackup(
	ctx: SummaContext,
	databaseUrl: string,
	localPath: string,
	schema: string,
): Promise<BackupRecord> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const fileName = generateFileName(schema);

	// Ensure backup directory exists
	if (!existsSync(localPath)) {
		mkdirSync(localPath, { recursive: true });
	}

	const filePath = join(localPath, fileName);

	// Create backup record
	const rows = await ctx.adapter.raw<RawBackupRow>(
		`INSERT INTO ${t("backup_history")} (id, file_name, storage, status, started_at)
		 VALUES (${d.generateUuid()}, $1, 'local', 'in_progress', ${d.now()})
		 RETURNING *`,
		[fileName],
	);

	const record = rows[0];
	if (!record) throw SummaError.internal("Failed to create backup record");

	try {
		// Run pg_dump
		await execFile("pg_dump", [
			databaseUrl,
			"--format=custom",
			"--no-owner",
			"--no-acl",
			`--schema=${schema}`,
			`--file=${filePath}`,
		]);

		// Get file size
		const stats = statSync(filePath);

		// Update record
		await ctx.adapter.rawMutate(
			`UPDATE ${t("backup_history")}
			 SET status = 'completed', size_bytes = $1, completed_at = ${d.now()}
			 WHERE id = $2`,
			[stats.size, record.id],
		);

		ctx.logger.info("Local backup completed", { fileName, sizeBytes: stats.size });

		return {
			...rawToBackup(record),
			status: "completed",
			sizeBytes: stats.size,
			completedAt: new Date().toISOString(),
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		await ctx.adapter.rawMutate(
			`UPDATE ${t("backup_history")}
			 SET status = 'failed', error_message = $1, completed_at = ${d.now()}
			 WHERE id = $2`,
			[errorMsg, record.id],
		);
		throw SummaError.internal(`Backup failed: ${errorMsg}`);
	}
}

async function performS3Backup(
	ctx: SummaContext,
	databaseUrl: string,
	localPath: string,
	schema: string,
	bucket: string,
	prefix: string,
	region: string,
): Promise<BackupRecord> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const fileName = generateFileName(schema);

	if (!existsSync(localPath)) {
		mkdirSync(localPath, { recursive: true });
	}

	const filePath = join(localPath, fileName);

	// Create backup record
	const rows = await ctx.adapter.raw<RawBackupRow>(
		`INSERT INTO ${t("backup_history")} (id, file_name, storage, status, started_at)
		 VALUES (${d.generateUuid()}, $1, 's3', 'in_progress', ${d.now()})
		 RETURNING *`,
		[fileName],
	);

	const record = rows[0];
	if (!record) throw SummaError.internal("Failed to create backup record");

	try {
		// Step 1: pg_dump to local temp file
		await execFile("pg_dump", [
			databaseUrl,
			"--format=custom",
			"--no-owner",
			"--no-acl",
			`--schema=${schema}`,
			`--file=${filePath}`,
		]);

		const stats = statSync(filePath);

		// Step 2: Upload to S3
		const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
		const s3 = new S3Client({ region });
		const s3Key = `${prefix}${fileName}`;

		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: s3Key,
				Body: createReadStream(filePath),
				ContentType: "application/octet-stream",
			}),
		);

		// Step 3: Clean up local temp file
		try {
			unlinkSync(filePath);
		} catch {
			// Ignore cleanup errors
		}

		// Update record
		await ctx.adapter.rawMutate(
			`UPDATE ${t("backup_history")}
			 SET status = 'completed', size_bytes = $1, completed_at = ${d.now()}
			 WHERE id = $2`,
			[stats.size, record.id],
		);

		ctx.logger.info("S3 backup completed", { fileName, bucket, key: s3Key, sizeBytes: stats.size });

		return {
			...rawToBackup(record),
			status: "completed",
			sizeBytes: stats.size,
			completedAt: new Date().toISOString(),
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		await ctx.adapter.rawMutate(
			`UPDATE ${t("backup_history")}
			 SET status = 'failed', error_message = $1, completed_at = ${d.now()}
			 WHERE id = $2`,
			[errorMsg, record.id],
		);

		// Clean up temp file on failure
		try {
			if (existsSync(filePath)) unlinkSync(filePath);
		} catch {
			// Ignore
		}

		throw SummaError.internal(`S3 backup failed: ${errorMsg}`);
	}
}

export async function listBackups(
	ctx: SummaContext,
	params?: { page?: number; perPage?: number; status?: string },
): Promise<{ backups: BackupRecord[]; hasMore: boolean; total: number }> {
	const t = createTableResolver(ctx.options.schema);
	const page = Math.max(1, params?.page ?? 1);
	const perPage = Math.min(params?.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const conditions: string[] = [];
	const queryParams: unknown[] = [];
	let idx = 1;

	if (params?.status) {
		conditions.push(`status = $${idx++}`);
		queryParams.push(params.status);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const countParams = [...queryParams];
	queryParams.push(perPage + 1, offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawBackupRow>(
			`SELECT * FROM ${t("backup_history")}
			 ${whereClause}
			 ORDER BY started_at DESC
			 LIMIT $${idx++} OFFSET $${idx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT ${ctx.dialect.countAsInt()} AS total FROM ${t("backup_history")} ${whereClause}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const backups = (hasMore ? rows.slice(0, perPage) : rows).map(rawToBackup);
	return { backups, hasMore, total: countRows[0]?.total ?? 0 };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function backup(options?: BackupOptions): SummaPlugin {
	const storage = options?.storage ?? "local";
	const localPath = options?.localPath ?? "./backups";
	const retentionDays = options?.retentionDays ?? 30;
	const s3Bucket = options?.s3Bucket;
	const s3Prefix = options?.s3Prefix ?? "summa-backups/";
	const s3Region = options?.s3Region ?? "us-east-1";

	return {
		id: "backup",

		$Infer: {} as { BackupRecord: BackupRecord },

		schema: backupSchema,

		workers: [
			{
				id: "scheduled-backup",
				description: `Scheduled ${storage} backup`,
				interval: options?.interval ?? "1d",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const dbUrl = options?.databaseUrl;
					if (!dbUrl) {
						ctx.logger.info("Backup skipped: no databaseUrl configured");
						return;
					}

					const schema = ctx.options.schema;

					if (storage === "s3" && s3Bucket) {
						await performS3Backup(ctx, dbUrl, localPath, schema, s3Bucket, s3Prefix, s3Region);
					} else {
						await performLocalBackup(ctx, dbUrl, localPath, schema);
					}
				},
			},
			{
				id: "backup-cleanup",
				description: `Remove backup records older than ${retentionDays} days`,
				interval: "1d",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const d = ctx.dialect;

					// Clean old local files
					if (storage === "local" && existsSync(localPath)) {
						const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
						try {
							const files = await readdir(localPath);
							for (const file of files) {
								const filePath = join(localPath, file);
								try {
									const stat = statSync(filePath);
									if (stat.mtimeMs < cutoff) {
										unlinkSync(filePath);
										ctx.logger.info("Deleted old backup file", { file });
									}
								} catch {
									// Skip files we can't stat/delete
								}
							}
						} catch {
							// Directory read failed
						}
					}

					// Clean old records
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM ${t("backup_history")}
						 WHERE started_at < ${d.now()} - ${d.interval("1 day")} * $1`,
						[retentionDays],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up old backup records", { count: deleted });
					}
				},
			},
		],

		endpoints: [
			// POST /backup -- Trigger immediate backup
			{
				method: "POST",
				path: "/backup",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const dbUrl = options?.databaseUrl;
					if (!dbUrl)
						return json(400, {
							error: { code: "CONFIGURATION_ERROR", message: "databaseUrl not configured" },
						});

					const body = req.body as { storage?: "local" | "s3" } | null;
					const targetStorage = body?.storage ?? storage;
					const schema = ctx.options.schema;

					let result: BackupRecord;
					if (targetStorage === "s3" && s3Bucket) {
						result = await performS3Backup(
							ctx,
							dbUrl,
							localPath,
							schema,
							s3Bucket,
							s3Prefix,
							s3Region,
						);
					} else {
						result = await performLocalBackup(ctx, dbUrl, localPath, schema);
					}

					return json(201, result);
				},
			},

			// GET /backup/history -- List backup history
			{
				method: "GET",
				path: "/backup/history",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listBackups(ctx, {
						page: req.query.page ? Number(req.query.page) : undefined,
						perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
						status: req.query.status,
					});
					return json(200, result);
				},
			},
		],
	};
}
