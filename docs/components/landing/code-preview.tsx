"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Clipboard, File } from "lucide-react";
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

	const isDark = !mounted || resolvedTheme === "dark";

	return (
		<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
			<div className="relative w-full overflow-hidden bg-zinc-950 border border-zinc-800 shadow-2xl shadow-black/20">
				{/* Title bar — VS Code style */}
				<div className="flex items-center border-b border-zinc-800 bg-zinc-900">
					{/* Tab strip */}
					<div className="flex items-stretch">
						{tabs.map((tab, index) => (
							<button
								type="button"
								key={tab.name}
								onClick={() => setActiveTab(index)}
								className={`relative flex items-center gap-2 px-4 h-9 text-xs font-mono border-r border-zinc-800 transition-colors ${
									activeTab === index
										? "bg-zinc-950 text-zinc-300"
										: "bg-zinc-900 text-zinc-500 hover:text-zinc-400 hover:bg-zinc-900/80"
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

					{/* Spacer + copy */}
					<div className="flex-1" />
					<button
						type="button"
						onClick={handleCopy}
						className="flex items-center justify-center size-9 text-zinc-500 hover:text-zinc-300 transition-colors"
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
								<Highlight
									theme={isDark ? themes.nightOwl : themes.nightOwl}
									code={tabs[activeTab]?.code ?? ""}
									language="typescript"
								>
									{({ tokens, getLineProps, getTokenProps }) => (
										<pre className="py-4 text-[13px] leading-6 overflow-x-auto no-scrollbar">
											<code>
												{tokens.map((line, i) => (
													<div
														key={`l${i.toString()}`}
														{...getLineProps({ line })}
														className="flex px-4 hover:bg-white/3 transition-colors duration-75"
													>
														<span className="select-none w-8 shrink-0 text-right pr-4 text-zinc-700 font-mono text-xs tabular-nums leading-6">
															{i + 1}
														</span>
														<span className="flex-1 min-w-0">
															{line.map((token, key) => (
																<span
																	key={`t${key.toString()}`}
																	{...getTokenProps({ token })}
																/>
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
