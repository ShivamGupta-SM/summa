"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useTheme } from "next-themes";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useState } from "react";
import useMeasure from "react-use-measure";

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

function TrafficLightsIcon(props: React.ComponentPropsWithoutRef<"svg">) {
	return (
		<svg aria-hidden="true" width="42" height="10" fill="none" {...props}>
			<circle cx="5" cy="5" r="4.5" className="fill-red-400" />
			<circle cx="21" cy="5" r="4.5" className="fill-amber-400" />
			<circle cx="37" cy="5" r="4.5" className="fill-emerald-400" />
		</svg>
	);
}

export function CodePreview() {
	const [activeTab, setActiveTab] = useState(0);
	const [copied, setCopied] = useState(false);
	const [mounted, setMounted] = useState(false);
	const { resolvedTheme } = useTheme();
	const [ref, bounds] = useMeasure();

	useEffect(() => {
		setMounted(true);
	}, []);

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

	return (
		<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
			<div className="relative w-full overflow-hidden bg-gradient-to-tr from-slate-100 to-slate-200 dark:from-slate-950/90 dark:via-slate-950 dark:to-slate-950/90 ring-1 ring-white/10 backdrop-blur-lg rounded-sm">
				<div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-4 py-3">
					<TrafficLightsIcon />
					<div className="flex items-center gap-1">
						{tabs.map((tab, index) => (
							<button
								key={tab.name}
								onClick={() => setActiveTab(index)}
								className="relative px-3 py-1 text-xs font-mono rounded-full"
							>
								{activeTab === index && (
									<motion.div
										layoutId="tab-code-preview"
										className="absolute inset-0 bg-slate-800 dark:bg-slate-700 rounded-full"
									/>
								)}
								<span
									className={`relative z-10 ${
										activeTab === index
											? "text-white"
											: "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
									}`}
								>
									{tab.name}
								</span>
							</button>
						))}
					</div>
					<button
						onClick={handleCopy}
						className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
						aria-label="Copy code"
					>
						{copied ? (
							<Check className="size-4" />
						) : (
							<Copy className="size-4" />
						)}
					</button>
				</div>
				<motion.div animate={{ height: bounds.height }} className="overflow-hidden">
					<div ref={ref}>
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.div
								key={activeTab}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
							>
								<Highlight
									theme={
										!mounted || resolvedTheme === "dark"
											? themes.nightOwl
											: themes.github
									}
									code={tabs[activeTab]?.code ?? ""}
									language="typescript"
								>
									{({ tokens, getLineProps, getTokenProps }) => (
										<pre className="px-4 py-4 text-[13px] leading-relaxed overflow-x-auto">
											<code>
												{tokens.map((line, i) => (
													<div key={i} {...getLineProps({ line })} className="flex">
														<span className="select-none w-8 shrink-0 text-right pr-4 text-slate-400 dark:text-slate-600 font-mono">
															{i + 1}
														</span>
														<span>
															{line.map((token, key) => (
																<span key={key} {...getTokenProps({ token })} />
															))}
														</span>
													</div>
												))}
											</code>
										</pre>
									)}
								</Highlight>
							</motion.div>
						</AnimatePresence>
					</div>
				</motion.div>
			</div>
		</MotionConfig>
	);
}
