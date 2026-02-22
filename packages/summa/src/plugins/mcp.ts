// =============================================================================
// MCP PLUGIN — Model Context Protocol integration for AI agents
// =============================================================================
// Exposes Summa ledger operations as MCP tools so AI agents can query
// balances, list transactions, and perform transfers.

import type {
	PluginApiRequest,
	PluginApiResponse,
	PluginEndpoint,
	SummaContext,
	SummaPlugin,
} from "@summa/core";

// =============================================================================
// TYPES
// =============================================================================

export interface McpOptions {
	/** Base path for MCP endpoints. Default: "/mcp" */
	basePath?: string;

	/** Authorization check. Return `true` to allow the MCP tool call. */
	authorize?: (req: PluginApiRequest) => boolean | Promise<boolean>;
}

interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const TOOLS: McpTool[] = [
	{
		name: "summa_get_balance",
		description: "Get the balance of an account by holder ID",
		inputSchema: {
			type: "object",
			properties: {
				holderId: { type: "string", description: "The account holder ID" },
			},
			required: ["holderId"],
		},
	},
	{
		name: "summa_list_accounts",
		description: "List accounts with optional filters (status, holderType)",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["active", "frozen", "closed"] },
				holderType: { type: "string", enum: ["individual", "organization", "system"] },
				page: { type: "number" },
				perPage: { type: "number" },
			},
		},
	},
	{
		name: "summa_get_transaction",
		description: "Get transaction details by ID",
		inputSchema: {
			type: "object",
			properties: {
				transactionId: { type: "string", description: "The transaction ID" },
			},
			required: ["transactionId"],
		},
	},
	{
		name: "summa_list_transactions",
		description: "List transactions for a holder with optional filters",
		inputSchema: {
			type: "object",
			properties: {
				holderId: { type: "string", description: "The account holder ID" },
				status: { type: "string" },
				type: { type: "string", enum: ["credit", "debit", "transfer", "journal"] },
				page: { type: "number" },
				perPage: { type: "number" },
			},
			required: ["holderId"],
		},
	},
	{
		name: "summa_transfer",
		description: "Transfer funds between two accounts",
		inputSchema: {
			type: "object",
			properties: {
				sourceHolderId: { type: "string" },
				destinationHolderId: { type: "string" },
				amount: { type: "number", description: "Amount in smallest currency unit" },
				reference: { type: "string" },
				description: { type: "string" },
			},
			required: ["sourceHolderId", "destinationHolderId", "amount", "reference"],
		},
	},
	{
		name: "summa_verify_equation",
		description: "Verify the accounting equation (assets = liabilities + equity)",
		inputSchema: { type: "object", properties: {} },
	},
];

// =============================================================================
// HELPERS
// =============================================================================

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function mcp(options?: McpOptions): SummaPlugin {
	const prefix = options?.basePath ?? "/mcp";
	const authorize = options?.authorize;

	function withAuth(handler: PluginEndpoint["handler"]): PluginEndpoint["handler"] {
		if (!authorize) return handler;
		return async (req, ctx) => {
			const allowed = await authorize(req);
			if (!allowed) return json(403, { error: "MCP access denied" });
			return handler(req, ctx);
		};
	}

	async function handleToolCall(
		toolName: string,
		args: Record<string, unknown>,
		ctx: SummaContext,
	): Promise<unknown> {
		switch (toolName) {
			case "summa_get_balance": {
				const { getAccountByHolder, getAccountBalance } = await import(
					"../managers/account-manager.js"
				);
				const account = await getAccountByHolder(ctx, args.holderId as string);
				return getAccountBalance(ctx, account);
			}
			case "summa_list_accounts": {
				const { listAccounts } = await import("../managers/account-manager.js");
				return listAccounts(ctx, {
					status: args.status as Parameters<typeof listAccounts>[1]["status"],
					holderType: args.holderType as Parameters<typeof listAccounts>[1]["holderType"],
					page: args.page as number | undefined,
					perPage: args.perPage as number | undefined,
				});
			}
			case "summa_get_transaction": {
				const { getTransaction } = await import("../managers/transaction-manager.js");
				return getTransaction(ctx, args.transactionId as string);
			}
			case "summa_list_transactions": {
				const { listAccountTransactions } = await import("../managers/transaction-manager.js");
				return listAccountTransactions(ctx, {
					holderId: args.holderId as string,
					status: args.status as Parameters<typeof listAccountTransactions>[1]["status"],
					type: args.type as Parameters<typeof listAccountTransactions>[1]["type"],
					page: args.page as number | undefined,
					perPage: args.perPage as number | undefined,
				});
			}
			case "summa_transfer": {
				const { transfer } = await import("../managers/transaction-manager.js");
				return transfer(ctx, {
					sourceHolderId: args.sourceHolderId as string,
					destinationHolderId: args.destinationHolderId as string,
					amount: args.amount as number,
					reference: args.reference as string,
					description: args.description as string | undefined,
				});
			}
			case "summa_verify_equation": {
				const { validateAccountingEquation } = await import("../managers/chart-of-accounts.js");
				const { getLedgerId } = await import("../managers/ledger-helpers.js");
				return validateAccountingEquation(ctx, getLedgerId(ctx));
			}
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	}

	const endpoints: PluginEndpoint[] = [
		// List available tools
		{
			method: "GET",
			path: `${prefix}/tools`,
			handler: async () => json(200, { tools: TOOLS }),
		},
		// Execute a tool
		{
			method: "POST",
			path: `${prefix}/tools/call`,
			handler: async (req, ctx) => {
				const body = req.body as { name?: string; arguments?: Record<string, unknown> };
				if (!body?.name) {
					return json(400, { error: "Missing tool name" });
				}
				const tool = TOOLS.find((t) => t.name === body.name);
				if (!tool) {
					return json(404, { error: `Unknown tool: ${body.name}` });
				}
				try {
					const result = await handleToolCall(body.name, body.arguments ?? {}, ctx);
					return json(200, {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					});
				} catch (err) {
					return json(500, {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						isError: true,
					});
				}
			},
		},
	];

	return {
		id: "mcp",
		endpoints: endpoints.map((ep) => ({ ...ep, handler: withAuth(ep.handler) })),
	};
}
