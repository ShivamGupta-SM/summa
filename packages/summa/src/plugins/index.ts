// =============================================================================
// SUMMA PLUGINS
// =============================================================================
// Plugin exports for the "summa/plugins" entry point.

export { type AdminOptions, admin } from "./admin.js";
export { type AuditLogEntry, type AuditLogOptions, auditLog, queryAuditLog } from "./audit-log.js";
export {
	type DlqManagerOptions,
	type DlqStats,
	dlqManager,
	type FailedEvent,
	getDlqStats,
	listUnresolvedEvents,
	resolveEvent,
	retryEvent,
} from "./dlq-manager.js";
export { type HoldExpiryOptions, holdExpiry } from "./hold-expiry.js";
export {
	getHotAccountStats,
	type HotAccountStats,
	type HotAccountsOptions,
	hotAccounts,
} from "./hot-accounts.js";
export { type MaintenanceOptions, maintenance } from "./maintenance.js";
export { type ObservabilityOptions, observability } from "./observability.js";
export { type OpenApiOptions, openApi } from "./open-api.js";
export { getOutboxStats, type OutboxOptions, type OutboxStats, outbox } from "./outbox.js";
export { getReconciliationStatus, reconciliation } from "./reconciliation.js";
export {
	type ScheduledTransactionsOptions,
	scheduledTransactions,
} from "./scheduled-transactions.js";
export { getEndOfMonthBalance, getHistoricalBalance, snapshots } from "./snapshots.js";
export {
	generateStatementCsv,
	generateStatementPdf,
	getAccountStatement,
	getStatementSummary,
	type StatementEntry,
	type StatementOptions,
	type StatementResult,
	type StatementSummary,
	statements,
} from "./statements.js";
export { type VelocityLimitsOptions, velocityLimits } from "./velocity-limits.js";
