"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Clipboard, File } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useMeasure from "react-use-measure";
import { tokenizeCode } from "@/lib/code-theme";

const tabs = [
	{
		name: "summa.config.ts",
		code: `import { createSumma } from "summa";
import { drizzleAdapter } from "summa/adapters/drizzle";
import { auditLog } from "summa/plugins/audit-log";
import { velocityLimits } from "summa/plugins/velocity-limits";

export const summa = createSumma({
  adapter: drizzleAdapter(db),
  currency: "USD",
  plugins: [
    auditLog(),
    velocityLimits({
      maxDaily: 10_000_00,
    }),
  ],
});`,
	},
	{
		name: "transfer.ts",
		code: `import { summa } from "./summa.config";

const transfer = await summa.transactions.transfer({
  from: "acc_alice",
  to: "acc_bob",
  amount: 5000,
  metadata: {
    reason: "Invoice #1042",
  },
});

// { id: "txn_...", entries: [...], ... }
console.log(transfer);`,
	},
];

export function CodePreview() {
	const [activeTab, setActiveTab] = useState(0);
	const [copied, setCopied] = useState(false);
	const [ref, bounds] = useMeasure();

	useEffect(() => {
		if (copied) {
			const timeout = setTimeout(() => setCopied(false), 2000);
			return () => clearTimeout(timeout);
		}
	}, [copied]);

	const handleCopy = () => {
		navigator.clipboard.writeText(tabs[activeTab]?.code ?? "");
		setCopied(true);
	};

	const code = tabs[activeTab]?.code ?? "";
	const lines = useMemo(() => tokenizeCode(code), [code]);

	return (
		<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
			<div className="sh relative w-full overflow-hidden bg-[#0a0a0a] border border-[#1a1a1a] shadow-2xl shadow-black/20 rounded-lg">
				{/* Title bar */}
				<div className="flex items-center border-b border-[#1a1a1a] bg-[#111111]">
					<div className="flex items-stretch overflow-x-auto no-scrollbar min-w-0">
						{tabs.map((tab, index) => (
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
										layoutId="code-preview-active"
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
