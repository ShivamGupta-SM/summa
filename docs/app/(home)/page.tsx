import {
	ArrowPathIcon,
	CheckCircleIcon,
	CircleStackIcon,
	CodeBracketSquareIcon,
	CubeTransparentIcon,
	FingerPrintIcon,
	LockClosedIcon,
	ShieldCheckIcon,
	ShieldExclamationIcon,
} from "@heroicons/react/24/outline";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { CodeExamples } from "@/components/landing/code-examples";
import { CodePreview } from "@/components/landing/code-preview";
import { GradientBG } from "@/components/landing/gradient-bg";
import { Ripple } from "@/components/landing/ripple";
import Section from "@/components/landing/section";
import { Spotlight } from "@/components/landing/spotlight";
import { cn } from "@/lib/utils";

const features = [
	{
		id: "double-entry",
		icon: CubeTransparentIcon,
		label: "Double Entry",
		href: "/docs/transactions",
		title: (
			<>
				Every <strong>transaction</strong> balances.
			</>
		),
		description:
			"Credits and debits enforced at the database level. No silent rounding errors, no unbalanced books.",
	},
	{
		id: "event-sourced",
		icon: ArrowPathIcon,
		label: "Event Sourced",
		href: "/docs/events",
		title: (
			<>
				Full <strong>audit trail</strong>, always.
			</>
		),
		description:
			"Every state change is an immutable event. Rebuild account state from any point in time.",
	},
	{
		id: "plugins",
		icon: CodeBracketSquareIcon,
		label: "Plugin Ecosystem",
		href: "/docs/plugins",
		title: (
			<>
				Extend with <strong>plugins</strong>.
			</>
		),
		description:
			"Audit logs, velocity limits, reconciliation, snapshots, scheduled transactions — compose what you need.",
	},
	{
		id: "adapters",
		icon: CircleStackIcon,
		label: "Multi-ORM",
		href: "/docs/adapters/drizzle",
		title: (
			<>
				Your <strong>ORM</strong>, your choice.
			</>
		),
		description:
			"Drizzle, Prisma, or Kysely. Swap adapters without changing business logic. All backed by PostgreSQL.",
	},
	{
		id: "holds",
		icon: LockClosedIcon,
		label: "Holds & Freezes",
		href: "/docs/holds",
		title: (
			<>
				Authorization <strong>holds</strong> built-in.
			</>
		),
		description:
			"Create holds, commit or void them. Freeze accounts with reason tracking. All first-class operations.",
	},
	{
		id: "type-safe",
		icon: ShieldCheckIcon,
		label: "Type-Safe",
		href: "/docs/configuration",
		title: (
			<>
				<strong>TypeScript</strong> from core to edge.
			</>
		),
		description:
			"Full inference through plugins, adapters, and configuration. Catch errors at compile time, not in production.",
	},
];

export default function HomePage() {
	return (
		<main className="h-min mx-auto overflow-x-hidden">
			{/* Announcement Bar */}
			<div className="bg-secondary/50 border-b border-dashed border-border">
				<div className="max-w-7xl mx-auto flex items-center justify-center h-12 px-4">
					<div className="flex flex-row items-center gap-2 text-xs md:text-sm">
						<span className="font-medium">Summa is now open source</span>
						<span className="text-muted-foreground hidden md:inline">|</span>
						<Link
							href="https://github.com/summa-ledger/summa"
							target="_blank"
							rel="noopener noreferrer"
							className="font-semibold text-brand hover:text-brand/80 transition-colors inline-flex items-center gap-1"
						>
							Star on GitHub
							<ArrowRight className="w-3 h-3" />
						</Link>
					</div>
				</div>
			</div>

			<Section
				className="mb-1 overflow-y-clip"
				customPaddings
				id="hero"
			>
				{/* Hero — Two Column */}
				<section className="relative w-full flex md:items-center md:justify-center bg-background antialiased min-h-[40rem] md:min-h-[50rem] lg:min-h-[40rem]">
					<Spotlight />

					{/* Background Dot Pattern */}
					<div className="absolute inset-0">
						<div className="absolute inset-0 bg-dot text-foreground/[0.07] dark:text-white/[0.04]" />
						<div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,oklch(0.55_0.17_160_/_0.08),transparent_70%)]" />
						<div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/60 to-background" />
					</div>

					{/* Content */}
					<div className="px-4 py-8 md:w-10/12 mx-auto relative z-10">
						<div className="mx-auto grid lg:max-w-8xl xl:max-w-full grid-cols-1 items-center gap-x-8 gap-y-16 px-4 py-2 lg:grid-cols-2 lg:px-8 lg:py-4 xl:gap-x-16 xl:px-0">
							{/* Left Column — Text */}
							<div className="relative z-10 text-left lg:mt-0">
								<div className="relative space-y-4">
									<div className="space-y-2">
										<div className="flex items-end gap-1 mt-2">
											<div className="flex items-center gap-1">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="0.8em"
													height="0.8em"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														fill="currentColor"
														d="M12 17l1.56-3.42L17 12l-3.44-1.56L12 7l-1.57 3.44L7 12l3.43 1.58z"
													/>
													<path
														fill="currentColor"
														d="M13 4V2c4.66.5 8.33 4.19 8.85 8.85c.6 5.49-3.35 10.43-8.85 11.03v-2c3.64-.45 6.5-3.32 6.96-6.96A7.994 7.994 0 0 0 13 4m-7.33.2A9.8 9.8 0 0 1 11 2v2.06c-1.43.2-2.78.78-3.9 1.68zM2.05 11a9.8 9.8 0 0 1 2.21-5.33L5.69 7.1A8 8 0 0 0 4.05 11zm2.22 7.33A10.04 10.04 0 0 1 2.06 13h2c.18 1.42.75 2.77 1.63 3.9zm1.4 1.41l1.39-1.37h.04c1.13.88 2.48 1.45 3.9 1.63v2c-1.96-.21-3.82-1-5.33-2.26"
													/>
												</svg>
												<span className="text-xs font-medium tracking-wide text-muted-foreground">
													Financial Infrastructure
												</span>
											</div>
										</div>

										<h1 className="text-foreground tracking-tighter text-3xl sm:text-4xl md:text-5xl text-pretty font-medium">
											The ledger your
											<br className="hidden sm:block" />
											{" "}money deserves.
										</h1>
										<p className="text-muted-foreground text-sm md:text-base max-w-md">
											Event-sourced, double-entry, type-safe — built for teams that
											ship financial infrastructure in TypeScript.
										</p>
									</div>

									{/* Terminal Install Command */}
									<div className="relative flex items-center gap-2 w-full sm:w-[90%] border border-white/10">
										<GradientBG className="w-full flex items-center justify-between gap-2">
											<div className="w-full flex flex-col min-[350px]:flex-row min-[350px]:items-center gap-0.5 min-[350px]:gap-2 min-w-0">
												<p className="text-xs sm:text-sm font-mono select-none tracking-tighter space-x-1 shrink-0">
													<span>
														<span className="text-sky-500">git:</span>
														<span className="text-red-400">(main)</span>
													</span>
													<span className="italic text-amber-600">x</span>
												</p>
												<p className="relative inline tracking-tight opacity-90 md:text-sm text-xs dark:text-white font-mono text-black">
													npm i{" "}
													<span className="relative dark:text-fuchsia-300 text-fuchsia-800">
														summa
														<span className="absolute h-2 bg-gradient-to-tr from-white via-slate-200 to-emerald-200/50 blur-3xl w-full top-0 left-2" />
													</span>
												</p>
											</div>
											{/* npm + GitHub icons */}
											<div className="flex items-center gap-2 shrink-0">
												<Link
													href="https://www.npmjs.com/package/summa"
													target="_blank"
													rel="noopener noreferrer"
													className="text-muted-foreground hover:text-foreground transition-colors"
													aria-label="npm"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="1.2em"
														height="1.2em"
														viewBox="0 0 256 256"
														aria-hidden="true"
													>
														<path
															fill="#cb3837"
															d="M0 256V0h256v256z"
														/>
														<path
															fill="#fff"
															d="M48 48h160v160h-32V80h-48v128H48z"
														/>
													</svg>
												</Link>
												<Link
													href="https://github.com/summa-ledger/summa"
													target="_blank"
													rel="noopener noreferrer"
													className="text-muted-foreground hover:text-foreground transition-colors"
													aria-label="GitHub"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="1.2em"
														height="1.2em"
														viewBox="0 0 496 512"
														aria-hidden="true"
													>
														<path
															fill="currentColor"
															d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8"
														/>
													</svg>
												</Link>
											</div>
										</GradientBG>
									</div>

									{/* CTA Buttons */}
									<div className="mt-4 flex w-fit flex-col gap-4 font-sans md:flex-row md:justify-center lg:justify-start items-center">
										<Link
											href="/docs"
											className="px-6 py-2 text-sm font-medium tracking-wide uppercase bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200 md:px-8"
										>
											Get Started
										</Link>
										<Link
											href="https://github.com/summa-ledger/summa"
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="1.2em"
												height="1.2em"
												viewBox="0 0 496 512"
												aria-hidden="true"
											>
												<path
													fill="currentColor"
													d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8"
												/>
											</svg>
											Star on GitHub
										</Link>
									</div>
								</div>
							</div>

							{/* Right Column — Code Preview */}
							<div className="relative md:block lg:static xl:pl-10">
								<div className="relative">
									<div className="from-emerald-400/50 via-sky-300/30 to-blue-400/40 absolute inset-0 rounded-none bg-gradient-to-tr opacity-10 blur-lg" />
									<div className="from-slate-300 via-slate-300/70 to-emerald-300/50 absolute inset-0 rounded-none bg-gradient-to-tr opacity-5" />
									<CodePreview />
								</div>
							</div>
						</div>
					</div>
				</section>
			</Section>
			{/* Features */}
			<Section className="" customPaddings id="features">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-16 lg:py-24">
					<div className="mb-12">
						<p className="text-xs font-mono uppercase tracking-widest text-brand mb-3">Core Features</p>
						<h2 className="text-3xl md:text-4xl font-medium tracking-tight">
							Everything you need.
							<br />
							<span className="text-muted-foreground">Nothing you don't.</span>
						</h2>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
						{features.map((feature) => (
							<div
								key={feature.id}
								className="bg-background p-8 lg:p-10"
							>
								<div className="flex items-center gap-2 mb-4">
									<feature.icon className="w-4 h-4 text-brand" />
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
										{feature.label}
									</p>
								</div>
								<h3 className="text-xl font-medium tracking-tight md:text-2xl">
									{feature.title}
								</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
									{feature.description}
									<a className="ml-2 underline" href={feature.href}>
										Learn more
									</a>
								</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* How It Works */}
			<Section className="bg-secondary/30 dark:bg-secondary/10" customPaddings id="how-it-works">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-16 lg:py-24">
					<div className="mb-12">
						<p className="text-xs font-mono uppercase tracking-widest text-brand mb-3">How It Works</p>
						<h2 className="text-2xl md:text-3xl font-medium tracking-tight">
							From zero to production in <strong>four steps</strong>.
						</h2>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
						{[
							{
								step: "01",
								label: "Configure",
								title: (
									<>
										Create a <strong>ledger</strong>.
									</>
								),
								description:
									"Set up Summa with your adapter, currency, and plugins. One config file, full type inference.",
							},
							{
								step: "02",
								label: "Accounts",
								title: (
									<>
										Open <strong>accounts</strong>.
									</>
								),
								description:
									"Create asset, liability, or equity accounts. Each gets a unique ID and immutable type.",
							},
							{
								step: "03",
								label: "Transact",
								title: (
									<>
										Post <strong>transactions</strong>.
									</>
								),
								description:
									"Transfer funds between accounts. Every transaction is double-entry balanced and immutable.",
							},
							{
								step: "04",
								label: "Query",
								title: (
									<>
										Read <strong>balances</strong>.
									</>
								),
								description:
									"Query balances, list events, generate reports. Replay history from any point in time.",
							},
						].map((item) => (
							<div
								key={item.step}
								className="bg-background p-8 lg:p-10"
							>
								<div className="flex items-center gap-3 mb-4">
									<span className="text-2xl font-light tracking-tight text-brand/40">
										{item.step}
									</span>
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
										{item.label}
									</p>
								</div>
								<h3 className="text-lg font-medium tracking-tight md:text-xl">
									{item.title}
								</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
									{item.description}
								</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Adapters */}
			<Section className="" customPaddings id="adapters">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-16 lg:py-24">
					<div className="mb-12">
						<p className="text-xs font-mono uppercase tracking-widest text-brand mb-3">Database Adapters</p>
						<h2 className="text-2xl md:text-3xl font-medium tracking-tight">
							Bring your own <strong>ORM</strong>.
						</h2>
						<p className="mt-2 text-sm text-muted-foreground max-w-lg">
							Swap adapters without touching business logic. Same API, same types, any database.
						</p>
					</div>
					<div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border border border-border">
						{[
							{
								name: "Drizzle",
								viewBox: "0 0 24 24",
								svg: (
									<path d="M5.353 11.823a1.036 1.036 0 0 0-.395-1.422 1.063 1.063 0 0 0-1.437.399L.138 16.702a1.035 1.035 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.398l3.383-5.903Zm11.216 0a1.036 1.036 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.399l-3.382 5.902a1.036 1.036 0 0 0 .394 1.422c.506.283 1.15.104 1.438-.398l3.382-5.903Zm7.293-4.525a1.036 1.036 0 0 0-.395-1.422 1.062 1.062 0 0 0-1.437.399l-3.383 5.902a1.036 1.036 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.399l3.383-5.902Zm-11.219 0a1.035 1.035 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.398l-3.382 5.903a1.036 1.036 0 0 0 .394 1.422c.506.282 1.15.104 1.438-.399l3.382-5.902Z" />
								),
							},
							{
								name: "Prisma",
								viewBox: "0 0 24 24",
								svg: (
									<path d="M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z" />
								),
							},
							{
								name: "Kysely",
								viewBox: "0 0 132 132",
								svg: (
									<>
										<rect x="2" y="2" width="128" height="128" rx="16" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeWidth="4" />
										<path d="M41.2983 109V23.9091H46.4918V73.31H47.0735L91.9457 23.9091H98.8427L61.9062 64.1694L98.5103 109H92.0288L58.5824 67.9087L46.4918 81.2873V109H41.2983Z" fill="currentColor" />
									</>
								),
							},
							{
								name: "PostgreSQL",
								viewBox: "0 0 24 24",
								svg: (
									<path d="M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z" />
								),
							},
							{
								name: "In-Memory",
								viewBox: "0 0 24 24",
								svg: (
									<path d="M16.5 7.5h-9v9h9v-9Z M8.25 2.25a.75.75 0 0 0-.75.75v.75h-.75A2.25 2.25 0 0 0 4.5 6v.75H3.75a.75.75 0 0 0 0 1.5h.75v2.25h-.75a.75.75 0 0 0 0 1.5h.75v2.25h-.75a.75.75 0 0 0 0 1.5h.75V18a2.25 2.25 0 0 0 2.25 2.25h.75v.75a.75.75 0 0 0 1.5 0v-.75h2.25v.75a.75.75 0 0 0 1.5 0v-.75h2.25v.75a.75.75 0 0 0 1.5 0v-.75H18a2.25 2.25 0 0 0 2.25-2.25v-.75h.75a.75.75 0 0 0 0-1.5h-.75v-2.25h.75a.75.75 0 0 0 0-1.5h-.75V8.25h.75a.75.75 0 0 0 0-1.5h-.75V6a2.25 2.25 0 0 0-2.25-2.25h-.75V3a.75.75 0 0 0-1.5 0v.75h-2.25V3a.75.75 0 0 0-1.5 0v.75H8.25V3a.75.75 0 0 0-.75-.75ZM6 6.75A.75.75 0 0 1 6.75 6h10.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V6.75Z" />
								),
							},
						].map((db) => (
							<div
								key={db.name}
								className="bg-background flex flex-col items-center justify-center p-8 md:p-10 gap-3"
							>
								<svg
									viewBox={db.viewBox}
									fill="currentColor"
									className="w-7 h-7 text-foreground/60"
									aria-hidden="true"
								>
									{db.svg}
								</svg>
								<p className="text-muted-foreground text-sm">
									{db.name}
								</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Code Examples */}
			<Section className="bg-secondary/30 dark:bg-secondary/10" customPaddings id="code-examples">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-16 lg:py-24">
					<div className="mb-12">
						<p className="text-xs font-mono uppercase tracking-widest text-brand mb-3">Beyond the Basics</p>
						<h2 className="text-2xl md:text-3xl font-medium tracking-tight">
							Production-grade from <strong>day one</strong>.
						</h2>
					</div>
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border">
						<div className="bg-background p-8 lg:p-10 flex flex-col justify-center">
							<h3 className="text-lg md:text-xl font-medium tracking-tight mb-3">
								Real financial primitives,<br />not toy abstractions.
							</h3>
							<p className="text-sm leading-relaxed text-muted-foreground">
								Authorization holds for payment processors.
								Event replay for audit compliance. Plugin
								composition for velocity limits, reconciliation,
								and snapshots — all type-safe.
							</p>
							<div className="mt-6 flex flex-col gap-2">
								{[
									"Authorization holds with commit/void",
									"Immutable event log with replay",
									"Composable plugins with type inference",
								].map((item) => (
									<div
										key={item}
										className="flex items-center gap-2 text-sm text-muted-foreground"
									>
										<Check className="w-3 h-3 shrink-0 text-brand" />
										{item}
									</div>
								))}
							</div>
						</div>
						<div className="bg-background p-6 md:p-10 flex items-center">
							<div className="w-full">
								<CodeExamples />
							</div>
						</div>
					</div>
				</div>
			</Section>

			{/* Security */}
			<Section className="" customPaddings id="security">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-16 lg:py-24">
					<div className="mb-12">
						<p className="text-xs font-mono uppercase tracking-widest text-brand mb-3">Security</p>
						<h2 className="text-3xl md:text-4xl font-medium tracking-tight">
							Trust is not optional.
						</h2>
						<p className="mt-3 text-sm md:text-base text-muted-foreground max-w-lg">
							Every layer is hardened — from parameterized queries to cryptographic audit trails.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
						{[
							{
								icon: ShieldCheckIcon,
								label: "SQL Injection Prevention",
								title: (
									<>
										<strong>Parameterized</strong> queries only.
									</>
								),
								description:
									"All queries use placeholders ($1, $2). Column names are quoted. No string interpolation ever touches the database.",
							},
							{
								icon: LockClosedIcon,
								label: "Concurrency Control",
								title: (
									<>
										No <strong>double-spending</strong>.
									</>
								),
								description:
									"PostgreSQL advisory locks + SELECT ... FOR UPDATE within atomic transactions. Concurrent operations are serialized.",
							},
							{
								icon: FingerPrintIcon,
								label: "Idempotency",
								title: (
									<>
										<strong>Replay</strong> prevention built-in.
									</>
								),
								description:
									"Every mutation accepts an idempotency key with configurable TTL. Unique reference constraints prevent re-execution.",
							},
							{
								icon: ArrowPathIcon,
								label: "Tamper Detection",
								title: (
									<>
										<strong>SHA-256</strong> hash chain.
									</>
								),
								description:
									"Hash chain per aggregate + block-level checkpoints. A single altered event breaks the chain.",
							},
							{
								icon: ShieldExclamationIcon,
								label: "Webhook Signing",
								title: (
									<>
										<strong>HMAC-SHA256</strong> signatures.
									</>
								),
								description:
									"Timing-safe comparison with configurable tolerance window. Rejects stale or replayed payloads.",
							},
							{
								icon: CheckCircleIcon,
								label: "Rate Limiting",
								title: (
									<>
										<strong>Token bucket</strong> limiter.
									</>
								),
								description:
									"3 backends (memory, database, Redis). Built-in presets: standard, strict, lenient, and burst.",
							},
						].map((item) => (
							<div
								key={item.label}
								className="bg-background p-8 lg:p-10"
							>
								<div className="flex items-center gap-2 mb-4">
									<item.icon className="w-4 h-4 text-brand" />
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
										{item.label}
									</p>
								</div>
								<h3 className="text-xl font-medium tracking-tight md:text-2xl">
									{item.title}
								</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
									{item.description}
								</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* CTA */}
			<Section className="bg-secondary/30 dark:bg-secondary/10" customPaddings id="cta">
				<div className="md:w-10/12 mx-auto px-4 md:px-0 py-20 lg:py-28">
					<div className="relative overflow-hidden border border-border bg-background p-12 md:p-16">
						<Ripple className="opacity-65" />
						<div className="relative z-10 flex flex-col items-center text-center gap-6">
							<p className="text-xs font-mono uppercase tracking-widest text-brand">Get Started</p>
							<h2 className="max-w-lg text-2xl md:text-4xl font-medium tracking-tight">
								Your ledger is waiting.
							</h2>
							<p className="text-muted-foreground text-sm md:text-base max-w-md">
								Ship financial infrastructure that's auditable, type-safe,
								and ready for scale — in an afternoon.
							</p>
							<Link
								href="/docs"
								className="px-8 py-2.5 text-sm font-medium tracking-wide uppercase bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200"
							>
								Read the Docs
							</Link>
						</div>
					</div>
				</div>
			</Section>
		</main>
	);
}
