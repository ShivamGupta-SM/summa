// Types

// Built-in Projections
export {
	AccountBalanceProjection,
	accountBalanceProjectionSchema,
} from "./built-in/account-balance.js";
export {
	TransactionHistoryProjection,
	transactionHistoryProjectionSchema,
} from "./built-in/transaction-history.js";
// CQRS Adapter
export { createCQRSAdapter } from "./cqrs-adapter.js";
// Projection Runner
export { projectionRunner } from "./projection-runner.js";
export type {
	CQRSAdapter,
	CQRSAdapterOptions,
	Projection,
	ProjectionRunnerOptions,
} from "./types.js";
