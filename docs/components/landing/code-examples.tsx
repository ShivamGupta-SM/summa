"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Clipboard, File } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useMeasure from "react-use-measure";
import { tokenizeCode } from "@/lib/code-theme";

const examples = [
	{
		name: "holds.ts",
		label: "Authorization Holds",
		code: `import { summa } from "./summa.config";

// Place a hold on funds
const hold = await summa.holds.create({
  account: "acc_alice",
  amount: 15_000, // $150.00
  reason: "Hotel reservation #4821",
  expiresAt: new Date("2025-03-15"),
});

// Later: commit the hold (charge the guest)
await summa.holds.commit(hold.id, {
  amount: 12_500, // Final charge: $125.00
});`,
	},
	{
		name: "events.ts",
		label: "Event Replay",
		code: `import { summa } from "./summa.config";

// Replay events to rebuild state
const history = await summa.events.list({
  account: "acc_alice",
  since: new Date("2025-01-01"),
});

for (const event of history) {
  console.log(event.type, event.data);
  // "transaction.created" { amount: 5000, ... }
  // "hold.committed"      { holdId: "hld_...", ... }
  // "account.frozen"      { reason: "compliance" }
}`,
	},
	{
		name: "fx-transfer.ts",
		label: "Multi-Currency",
		code: `import { summa } from "./summa.config";

// Transfer across currencies — FX resolved automatically
const tx = await summa.transactions.transfer({
  source: "acc_usd_treasury",
  destination: "acc_eur_vendor",
  amount: 10_000, // $100.00 USD
  destinationCurrency: "EUR",
  reference: "Invoice #1092",
});

// tx.fxRate     → 0.9231
// tx.fxAmount   → 9231  (€92.31 EUR)
// tx.gainLoss   → tracked automatically`,
	},
	{
		name: "plugins.ts",
		label: "Plugin Config",
		code: `import { createSumma } from "@summa-ledger/summa";
import { drizzleAdapter } from "@summa-ledger/summa/adapters/drizzle";
import { auditLog } from "@summa-ledger/summa/plugins/audit-log";
import { velocityLimits } from "@summa-ledger/summa/plugins/velocity-limits";
import { reconciliation } from "@summa-ledger/summa/plugins/reconciliation";
import { snapshots } from "@summa-ledger/summa/plugins/snapshots";

export const summa = createSumma({
  adapter: drizzleAdapter(db),
  plugins: [
    auditLog({ retention: "90d" }),
    velocityLimits({ maxDaily: 50_000_00 }),
    reconciliation({ schedule: "0 2 * * *" }),
    snapshots({ interval: "1h" }),
  ],
});`,
	},
];

export function CodeExamples({ defaultTab = 0 }: { defaultTab?: number }) {
	const [activeTab, setActiveTab] = useState(defaultTab);
	const [copied, setCopied] = useState(false);
	const [ref, bounds] = useMeasure();

	useEffect(() => {
		if (copied) {
			const timeout = setTimeout(() => setCopied(false), 2000);
			return () => clearTimeout(timeout);
		}
	}, [copied]);

	const handleCopy = () => {
		navigator.clipboard.writeText(examples[activeTab]?.code ?? "");
		setCopied(true);
	};

	const code = examples[activeTab]?.code ?? "";
	const lines = useMemo(() => tokenizeCode(code), [code]);

	return (
		<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
			<div className="sh relative w-full overflow-hidden bg-[#0a0a0a] border border-[#1a1a1a] shadow-2xl shadow-black/20 rounded-lg">
				{/* Title bar */}
				<div className="flex items-center border-b border-[#1a1a1a] bg-[#111111]">
					<div className="flex items-stretch overflow-x-auto no-scrollbar">
						{examples.map((tab, index) => (
							<button
								type="button"
								key={tab.name}
								onClick={() => setActiveTab(index)}
								className={`relative flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 h-9 text-xs sm:text-[13px] font-code font-normal border-r border-[#1a1a1a] transition-colors whitespace-nowrap shrink-0 ${
									activeTab === index
										? "bg-[#0a0a0a] text-[#a0a0a0]"
										: "bg-[#111111] text-[#555555] hover:text-[#777777]"
								}`}
							>
								{activeTab === index && (
									<motion.div
										layoutId="code-examples-active"
										className="absolute top-0 left-0 right-0 h-px bg-brand"
									/>
								)}
								<File className="size-3 shrink-0 opacity-50" />
								{tab.name}
							</button>
						))}
					</div>

					<div className="flex-1" />
					<button
						type="button"
						onClick={handleCopy}
						className="flex items-center justify-center size-9 text-[#555555] hover:text-[#a0a0a0] transition-colors"
						aria-label="Copy code"
					>
						{copied ? (
							<Check className="size-3.5 text-emerald-400" />
						) : (
							<Clipboard className="size-3.5" />
						)}
					</button>
				</div>

				{/* Code area */}
				<motion.div animate={{ height: bounds.height }} className="overflow-hidden">
					<div ref={ref}>
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.div
								key={activeTab}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
							>
								<pre className="py-4 overflow-x-auto no-scrollbar font-code text-[13px] sm:text-[14px] leading-[1.7] font-normal antialiased" style={{ fontFeatureSettings: '"liga", "calt"' }}>
									<code>
										{lines.map((line, i) => (
											<div
												key={`l${i.toString()}`}
												className="flex px-4 hover:bg-white/2 transition-colors duration-75"
											>
												<span className="select-none w-8 shrink-0 text-right pr-4 text-[#333333] text-[13px] sm:text-[14px] tabular-nums">
													{i + 1}
												</span>
												<span className="flex-1 min-w-0">
													{line.tokens.map((token, j) => (
														<span key={`t${j.toString()}`} className={token.type}>
															{token.value}
														</span>
													))}
												</span>
											</div>
										))}
									</code>
								</pre>
							</motion.div>
						</AnimatePresence>
					</div>
				</motion.div>
			</div>
		</MotionConfig>
	);
}
