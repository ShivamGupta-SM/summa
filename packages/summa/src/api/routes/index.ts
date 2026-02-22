// =============================================================================
// ROUTE INDEX — Aggregates all domain routes into a single array
// =============================================================================

import type { Route } from "../handler.js";
import { accountRoutes } from "./account-routes.js";
import { eventRoutes } from "./event-routes.js";
import { holdRoutes } from "./hold-routes.js";
import { ledgerRoutes } from "./ledger-routes.js";
import { limitRoutes } from "./limit-routes.js";
import { transactionRoutes } from "./transaction-routes.js";

// Route ordering matters: specific paths MUST come before parametric paths.
export const routes: Route[] = [
	...ledgerRoutes,
	...accountRoutes,
	...transactionRoutes,
	...holdRoutes,
	...limitRoutes,
	...eventRoutes,
];
