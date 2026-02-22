// =============================================================================
// SUMMA PLUGINS
// =============================================================================
// Plugin exports for the "@summa-ledger/summa/plugins" entry point.
//
// Plugins are organized by category:
//   CORE — Performance-critical plugins recommended for all deployments
//   INFRASTRUCTURE — Event delivery, monitoring, and operational tooling
//   ACCOUNTING — Specialized accounting features (accruals, periods, reporting)
//   SECURITY — API keys, identity management, approval workflows
//   INTEGRATIONS — Search, i18n, MCP, OpenAPI, and external system bridges

// =============================================================================
// CORE — Performance & integrity plugins (recommended for production)
// =============================================================================

export { type AuditLogEntry, type AuditLogOptions, auditLog, queryAuditLog } from "./audit-log.js";
export {
	type BatchableTransaction,
	type BatchEngineOptions,
	batchEngine,
	TransactionBatchEngine,
} from "./batch-engine.js";
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
export { type EventStorePartitionOptions, eventStorePartition } from "./event-store-partition.js";
export {
	type HashSnapshotOptions,
	hashSnapshot,
	type VerificationSnapshotsOptions,
	verificationSnapshots,
} from "./hash-snapshot.js";
export {
	getHotAccountStats,
	type HotAccountStats,
	type HotAccountsOptions,
	hotAccounts,
} from "./hot-accounts.js";
export {
	createStreamPublisher,
	deleteWebhook,
	getDeliveryLog,
	getOutboxStats,
	listWebhooks,
	type MessageBusLike,
	type OutboxOptions,
	type OutboxStats,
	outbox,
	registerWebhook,
	type StreamPublisherOptions,
	updateWebhook,
	type WebhookDelivery,
	type WebhookEndpoint,
	type WebhookOptions,
} from "./outbox.js";
export {
	type BlockCheckpointAnchor,
	getReconciliationStatus,
	type ReconciliationOptions,
	reconciliation,
} from "./reconciliation.js";
export { type VelocityLimitsOptions, velocityLimits } from "./velocity-limits.js";

// =============================================================================
// INFRASTRUCTURE — Operational and maintenance plugins
// =============================================================================

export { type AdminOptions, admin } from "./admin.js";
export {
	type BackupOptions,
	type BackupRecord,
	backup,
	listBackups as listBackupRecords,
} from "./backup.js";
export {
	type BalanceMonitorOptions,
	type BalanceMonitorRecord,
	balanceMonitor,
	createMonitor,
	deleteMonitor,
	listMonitors,
	type MonitorField,
	type MonitorOperator,
	updateMonitor,
} from "./balance-monitor.js";
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
export { type FreezeExpiryOptions, freezeExpiry } from "./freeze-expiry.js";
export { type ObservabilityOptions, observability } from "./observability.js";
export {
	type CreateScheduledTransactionParams,
	cancelScheduledTransaction,
	createScheduledTransaction,
	getScheduledTransaction,
	listScheduledTransactions,
	type RecurrenceInput,
	type ScheduledTransaction,
	type ScheduledTransactionStatus,
	type ScheduledTransactionsOptions,
	scheduledTransactions,
} from "./scheduled-transactions.js";
export { getEndOfMonthBalance, getHistoricalBalance, snapshots } from "./snapshots.js";
export { type VersionRetentionOptions, versionRetention } from "./version-retention.js";

// =============================================================================
// ACCOUNTING — Specialized accounting features
// =============================================================================

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
export {
	type AgingSnapshot,
	type ArApOptions,
	allocatePayment,
	arAp,
	createInvoice,
	getAgingReport,
	getInvoice,
	type Invoice,
	type InvoiceLineItem,
	type InvoiceStatus,
	type InvoiceType,
	issueInvoice,
	listAllocations,
	listInvoices,
	type PaymentAllocation,
	voidInvoice,
} from "./ar-ap.js";
export {
	type BankReconciliationOptions,
	type BankReconciliationSummary,
	bankReconciliation,
	type ExternalTransaction,
	type ExternalTxnStatus,
	excludeTransaction,
	getReconciliationSummary as getBankReconciliationSummary,
	importFeed,
	listUnmatchedTransactions,
	type MatchMethod,
	type MatchResult,
	manualMatch,
	runAutoMatch,
} from "./bank-reconciliation.js";
export {
	type Budget,
	type BudgetingOptions,
	type BudgetPeriod,
	type BudgetSnapshot,
	budgeting,
	createBudget,
	deleteBudget,
	getBudget,
	listBudgets,
	updateBudget,
} from "./budgeting.js";
export {
	type BalanceSheet,
	financialReporting,
	getBalanceSheet,
	getIncomeStatement,
	getTrialBalance,
	type IncomeStatement,
	type TrialBalance,
} from "./financial-reporting.js";
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
export {
	type AccountingPeriod,
	isPeriodClosed,
	type PeriodCloseOptions,
	periodClose,
} from "./period-close.js";
export {
	generateSaftReport,
	generateXbrlReport,
	type RegulatoryReportingOptions,
	regulatoryReporting,
	type SaftAccount,
	type SaftJournal,
	type SaftReport,
	type SaftTransaction,
	type XbrlFact,
	type XbrlReport,
} from "./regulatory-reporting.js";
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
export { jaro, jaroWinkler, levenshtein, normalizedLevenshtein } from "./string-similarity.js";
export {
	createTaxCode,
	getCurrentRate,
	getEntriesForTransaction,
	getTaxSummary,
	listTaxCodes,
	listTaxRates,
	type TaxCode,
	type TaxEntry,
	type TaxRate,
	type TaxSummary,
	type TaxTrackingOptions,
	taxTracking,
	updateTaxRate,
} from "./tax-tracking.js";

// =============================================================================
// SECURITY — Access control and identity management
// =============================================================================

export {
	type ApiKey,
	type ApiKeyOptions,
	type ApiKeyScope,
	type ApiKeyWithSecret,
	apiKeys,
	createApiKeyRecord,
	listApiKeys as listApiKeyRecords,
	revokeApiKey,
	rotateApiKey,
} from "./api-keys.js";
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
export {
	createIdentity,
	decryptField,
	deleteIdentity,
	detokenizeFields,
	encryptField,
	getIdentity,
	getIdentityByHolder,
	type Identity,
	type IdentityOptions,
	identity,
	linkIdentityToAccount,
	listIdentities,
	listTokenizedFields,
	type TokenizableField,
	type TokenizedFieldInfo,
	tokenizeFields,
	updateIdentity,
} from "./identity.js";

// =============================================================================
// INTEGRATIONS — External systems and developer tools
// =============================================================================

export {
	defineTranslations,
	type I18nOptions,
	i18n,
	type LocaleDetectionStrategy,
	type TranslationMap,
} from "./i18n.js";
export { type McpOptions, mcp } from "./mcp.js";
export { type OpenApiOptions, openApi } from "./open-api.js";
export {
	type MeilisearchConfig,
	meilisearchBackend,
	type PgSearchConfig,
	pgSearchBackend,
	type ReindexStatus,
	type SearchBackend,
	type SearchCollection,
	type SearchCollectionConfig,
	type SearchFieldConfig,
	type SearchHit,
	type SearchOptions,
	type SearchQuery,
	type SearchResult,
	search,
	type TypesenseConfig,
	typesenseBackend,
} from "./search.js";
