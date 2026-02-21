// =============================================================================
// SUMMA PLUGINS
// =============================================================================
// Plugin exports for the "summa/plugins" entry point.

// -- New plugins (Features 3, 4, 6, 7, 8, 9, 10) --
export {
	type AccrualAccountingOptions,
	type AccrualFrequency,
	type AccrualPosting,
	type AccrualSchedule,
	type AccrualStatus,
	type AccrualType,
	accrualAccounting,
	cancelSchedule,
	createAccrualSchedule,
	processAccruals,
} from "./accrual-accounting.js";
export { type AdminOptions, admin } from "./admin.js";
export {
	type ApprovalConditionType,
	type ApprovalRequest,
	type ApprovalRule,
	type ApprovalWorkflowOptions,
	approvalWorkflow,
	approveRequest,
	createRule,
	getApprovalRequest,
	listPendingRequests,
	listRules,
	rejectRequest,
} from "./approval-workflow.js";
export { type AuditLogEntry, type AuditLogOptions, auditLog, queryAuditLog } from "./audit-log.js";
export {
	type BatchImportOptions,
	type BatchItem,
	type BatchStatus,
	batchImport,
	createBatch,
	getBatchStatus,
	type ImportBatch,
	listBatches,
	postBatch,
	validateBatch,
} from "./batch-import.js";
export { type DataRetentionOptions, dataRetention } from "./data-retention.js";
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
export {
	type BalanceSheet,
	financialReporting,
	getBalanceSheet,
	getIncomeStatement,
	getTrialBalance,
	type IncomeStatement,
	type TrialBalance,
} from "./financial-reporting.js";
export { type FreezeExpiryOptions, freezeExpiry } from "./freeze-expiry.js";
export {
	createRateQuote,
	type FxEngineOptions,
	type FxQuote,
	type FxRate,
	type FxRateProvider,
	fxEngine,
	getRate,
} from "./fx-engine.js";
export {
	type GlSubLedgerOptions,
	type GlSummary,
	getGlSummary,
	glSubLedger,
	type ReconciliationResult,
	reconcile,
	registerSubLedger,
} from "./gl-sub-ledger.js";
export { type HoldExpiryOptions, holdExpiry } from "./hold-expiry.js";
export {
	getHotAccountStats,
	type HotAccountStats,
	type HotAccountsOptions,
	hotAccounts,
} from "./hot-accounts.js";
export {
	defineTranslations,
	type I18nOptions,
	i18n,
	type LocaleDetectionStrategy,
	type TranslationMap,
} from "./i18n.js";
export { type MaintenanceOptions, maintenance } from "./maintenance.js";
export { type McpOptions, mcp } from "./mcp.js";
export { type ObservabilityOptions, observability } from "./observability.js";
export { type OpenApiOptions, openApi } from "./open-api.js";
export { getOutboxStats, type OutboxOptions, type OutboxStats, outbox } from "./outbox.js";
export {
	type AccountingPeriod,
	isPeriodClosed,
	type PeriodCloseOptions,
	periodClose,
} from "./period-close.js";
export {
	type BlockCheckpointAnchor,
	getReconciliationStatus,
	type ReconciliationOptions,
	reconciliation,
} from "./reconciliation.js";
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
	type StatementJob,
	type StatementJobStatus,
	type StatementOptions,
	type StatementResult,
	type StatementSummary,
	statements,
} from "./statements.js";
export { type VelocityLimitsOptions, velocityLimits } from "./velocity-limits.js";
export { type VersionRetentionOptions, versionRetention } from "./version-retention.js";
