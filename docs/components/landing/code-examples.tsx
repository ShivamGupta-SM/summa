"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useTheme } from "next-themes";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useState } from "react";
import useMeasure from "react-use-measure";

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
		name: "plugins.ts",
		label: "Plugin Config",
		code: `import { createSumma } from "summa";
import { drizzleAdapter } from "summa/adapters/drizzle";
import { auditLog } from "summa/plugins/audit-log";
import { velocityLimits } from "summa/plugins/velocity-limits";
import { reconciliation } from "summa/plugins/reconciliation";
import { snapshots } from "summa/plugins/snapshots";

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

function TrafficLightsIcon(props: React.ComponentPropsWithoutRef<"svg">) {
	return (
		<svg aria-hidden="true" width="42" height="10" fill="none" {...props}>
			<circle cx="5" cy="5" r="4.5" className="fill-red-400" />
			<circle cx="21" cy="5" r="4.5" className="fill-amber-400" />
			<circle cx="37" cy="5" r="4.5" className="fill-emerald-400" />
		</svg>
	);
}

export function CodeExamples() {
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
		navigator.clipboard.writeText(examples[activeTab]?.code ?? "");
		setCopied(true);
	};

	return (
		<MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
			<div className="relative w-full overflow-hidden bg-gradient-to-tr from-stone-100 to-stone-200 dark:from-stone-950/90 dark:via-black dark:to-black/90 ring-1 ring-white/10 backdrop-blur-lg rounded-sm">
				<div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-800 px-4 py-3">
					<TrafficLightsIcon />
					<div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
						{examples.map((tab, index) => (
							<button
								key={tab.name}
								onClick={() => setActiveTab(index)}
								className="relative px-3 py-1 text-xs font-mono rounded-full whitespace-nowrap"
							>
								{activeTab === index && (
									<motion.div
										layoutId="tab-code-examples"
										className="absolute inset-0 bg-stone-800 dark:bg-stone-700 rounded-full"
									/>
								)}
								<span
									className={`relative z-10 ${
										activeTab === index
											? "text-white"
											: "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
									}`}
								>
									{tab.name}
								</span>
							</button>
						))}
					</div>
					<button
						onClick={handleCopy}
						className="text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
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
									code={examples[activeTab]?.code ?? ""}
									language="typescript"
								>
									{({ tokens, getLineProps, getTokenProps }) => (
										<pre className="px-4 py-4 text-[13px] leading-relaxed overflow-x-auto">
											<code>
												{tokens.map((line, i) => (
													<div key={i} {...getLineProps({ line })} className="flex">
														<span className="select-none w-8 shrink-0 text-right pr-4 text-stone-400 dark:text-stone-600 font-mono">
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
