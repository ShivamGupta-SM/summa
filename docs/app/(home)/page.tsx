import {
	ArrowPathIcon,
	ArrowUpTrayIcon,
	ArrowsRightLeftIcon,
	BanknotesIcon,
	BoltIcon,
	BookOpenIcon,
	BuildingStorefrontIcon,
	CalculatorIcon,
	CalendarDaysIcon,
	ChartBarIcon,
	ChartBarSquareIcon,
	CheckBadgeIcon,
	CircleStackIcon,
	ClipboardDocumentListIcon,
	ClockIcon,
	CodeBracketSquareIcon,
	Cog6ToothIcon,
	CreditCardIcon,
	CubeTransparentIcon,
	CurrencyDollarIcon,
	DocumentMagnifyingGlassIcon,
	FingerPrintIcon,
	FireIcon,
	FunnelIcon,
	GlobeAltIcon,
	EyeSlashIcon,
	HandRaisedIcon,
	InboxStackIcon,
	LanguageIcon,
	LockClosedIcon,
	NoSymbolIcon,
	CpuChipIcon,
	ShieldCheckIcon,
	ShieldExclamationIcon,
	SignalIcon,
	TableCellsIcon,
	UserGroupIcon,
	WalletIcon,
	WrenchScrewdriverIcon,
	KeyIcon,
	MagnifyingGlassIcon,
	CloudArrowUpIcon,
} from "@heroicons/react/24/outline";
import { ArrowRight, Check, Plus } from "lucide-react";
import Link from "next/link";
import { AccentCard } from "@/components/landing/accent-card";
import { AnimateIn } from "@/components/landing/animate-in";
import { CodeExamples } from "@/components/landing/code-examples";
import { CodePreview } from "@/components/landing/code-preview";
import { Counter } from "@/components/landing/counter";
import { GradientBG } from "@/components/landing/gradient-bg";
import { InteractiveGrid } from "@/components/landing/interactive-grid";
import Section from "@/components/landing/section";
import { Spotlight } from "@/components/landing/spotlight";
import { TextScramble } from "@/components/landing/text-scramble";

const features = [
	{
		id: "double-entry",
		icon: CubeTransparentIcon,
		color: "text-accent-blue",
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
		color: "text-accent-violet",
		label: "Event Sourced",
		href: "/docs/events",
		title: (
			<>
				Full <strong>audit trail</strong>, always.
			</>
		),
		description:
			"Every state change is an immutable, append-only event. No UPDATEs, no DELETEs on financial data. Rebuild account state from any point in time.",
	},
	{
		id: "plugins",
		icon: CodeBracketSquareIcon,
		color: "text-accent-amber",
		label: "Plugin Ecosystem",
		href: "/docs/plugins",
		title: (
			<>
				Extend with <strong>plugins</strong>.
			</>
		),
		description:
			"34 plugins + 3 core workers — audit logs, velocity limits, reconciliation, identity management, API keys, webhook delivery, full-text search, balance monitoring, backups, transaction batching, CQRS projections, and more. Compose what you need.",
	},
	{
		id: "adapters",
		icon: CircleStackIcon,
		color: "text-accent-emerald",
		label: "Multi-ORM",
		href: "/docs/adapters/drizzle",
		title: (
			<>
				Your <strong>ORM</strong>, your choice.
			</>
		),
		description:
			"Drizzle, Prisma, or Kysely. PostgreSQL, MySQL, or SQLite. Swap adapters and dialects without changing business logic.",
	},
	{
		id: "holds",
		icon: LockClosedIcon,
		color: "text-accent-rose",
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
		id: "multi-currency",
		icon: CurrencyDollarIcon,
		color: "text-brand",
		label: "Multi-Currency",
		href: "/docs/plugins/fx-engine",
		title: (
			<>
				Cross-currency <strong>transfers</strong>.
			</>
		),
		description:
			"Built-in FX engine auto-resolves exchange rates, caches quotes, and tracks realized gain/loss. Transfer between USD, EUR, BTC — any currency pair.",
	},
	{
		id: "multi-tenancy",
		icon: UserGroupIcon,
		color: "text-accent-violet",
		label: "Multi-Tenancy",
		href: "/docs/multi-tenancy",
		title: (
			<>
				Ledger-as-<strong>namespace</strong> isolation.
			</>
		),
		description:
			"Each tenant gets its own ledger with isolated accounts, transactions, system accounts, and event chains. Same holderId, same reference — different ledgers, zero leakage.",
	},
];

const useCases = [
	{
		icon: WalletIcon,
		color: "text-accent-violet",
		label: "Digital Wallets",
		description: "User balances, top-ups, peer-to-peer transfers with real-time balance tracking and holds.",
	},
	{
		icon: CreditCardIcon,
		color: "text-accent-blue",
		label: "Payment Processing",
		description: "Authorization holds, capture/void flows, multi-currency settlements with idempotent operations.",
	},
	{
		icon: BuildingStorefrontIcon,
		color: "text-accent-amber",
		label: "Marketplace Payouts",
		description: "Split payments, escrow accounts, seller disbursements with multi-destination transfers.",
	},
	{
		icon: BanknotesIcon,
		color: "text-accent-emerald",
		label: "Lending & Credit",
		description: "Loan disbursement, repayment tracking, interest accrual with scheduled transactions.",
	},
	{
		icon: CurrencyDollarIcon,
		color: "text-accent-rose",
		label: "SaaS Billing",
		description: "Usage-based metering, prepaid credits, subscription lifecycle with velocity limits.",
	},
	{
		icon: CubeTransparentIcon,
		color: "text-brand",
		label: "Crypto & DeFi",
		description: "On-chain reconciliation, multi-asset tracking, atomic swaps with event-sourced audit trails.",
	},
];

const plugins = [
	{ name: "Audit Log", description: "Append-only event log with HMAC integrity hashes", icon: ClipboardDocumentListIcon },
	{ name: "Reconciliation", description: "Merkle tree verification and double-entry balance checks", icon: ArrowsRightLeftIcon },
	{ name: "Snapshots", description: "Point-in-time balance snapshots for reporting", icon: TableCellsIcon },
	{ name: "Velocity Limits", description: "Rate and amount limits per account or holder", icon: FunnelIcon },
	{ name: "Expiry", description: "Auto-expire holds and auto-unfreeze accounts after TTL", icon: ClockIcon },
	{ name: "Scheduled Tx", description: "Future-dated transactions with cron triggers", icon: ClockIcon },
	{ name: "Outbox", description: "Transactional outbox with built-in webhook delivery and HMAC signing", icon: InboxStackIcon },
	{ name: "DLQ Manager", description: "Capture and replay failed operations", icon: ShieldExclamationIcon },
	{ name: "Hot Accounts", description: "Optimized high-throughput account handling", icon: FireIcon },
	{ name: "Admin", description: "Management API for accounts and operations", icon: Cog6ToothIcon },
	{ name: "Statements", description: "Generate account statements in JSON or CSV", icon: DocumentMagnifyingGlassIcon },
	{ name: "OpenAPI", description: "Auto-generated API documentation", icon: CodeBracketSquareIcon },
	{ name: "Observability", description: "Metrics, traces, and structured logging", icon: SignalIcon },
	{ name: "Maintenance", description: "Database cleanup and optimization tasks", icon: WrenchScrewdriverIcon },
	{ name: "Accrual Accounting", description: "Revenue recognition and expense matching with journal entries", icon: CalculatorIcon },
	{ name: "Approval Workflow", description: "Multi-step approval chains for high-value transactions", icon: CheckBadgeIcon },
	{ name: "Batch Import", description: "Bulk import transactions from CSV or external systems", icon: ArrowUpTrayIcon },
	{ name: "Financial Reporting", description: "Balance sheets, income statements, and trial balances", icon: ChartBarSquareIcon },
	{ name: "FX Engine", description: "Auto-resolves exchange rates for cross-currency transfers", icon: GlobeAltIcon },
	{ name: "Data Retention", description: "Configurable cleanup policies for sensitive operational data", icon: ClockIcon },
	{ name: "GL Sub-Ledger", description: "General ledger integration with chart of accounts mapping", icon: BookOpenIcon },
	{ name: "Period Close", description: "Fiscal period closing with validation and rollover", icon: CalendarDaysIcon },
	{ name: "i18n", description: "Multi-locale error messages with Accept-Language detection", icon: LanguageIcon },
	{ name: "Version Retention", description: "Archive and prune old balance versions to keep tables bounded", icon: ClockIcon },
	{ name: "MCP", description: "AI agent tools for balance queries, transfers, and verification", icon: CpuChipIcon },
	{ name: "Identity", description: "KYC identity management with AES-256-GCM PII tokenization", icon: FingerPrintIcon },
	{ name: "API Keys", description: "SHA-256 hashed key management with scoped permissions and rotation", icon: KeyIcon },
	{ name: "Balance Monitor", description: "Real-time condition-based balance alerts and threshold triggers", icon: ChartBarSquareIcon },
	{ name: "Backup", description: "Automated PostgreSQL backups with local disk and S3 storage", icon: CloudArrowUpIcon },
	{ name: "Search", description: "Native PostgreSQL full-text search with optional Typesense and Meilisearch backends", icon: MagnifyingGlassIcon },
	{ name: "Batch Engine", description: "TigerBeetle-inspired transaction batching with balancing debits and 10,000+ TPS throughput", icon: BoltIcon },
	{ name: "Event Store Partition", description: "PostgreSQL range partitioning with automated maintenance and archive", icon: TableCellsIcon },
	{ name: "Verification Snapshots", description: "O(recent events) hash verification via per-aggregate snapshots", icon: ShieldCheckIcon },
	{ name: "Message Queue", description: "Redis Streams message bus for high-throughput event delivery", icon: InboxStackIcon },
	{ name: "Projections", description: "CQRS read models with separate read/write paths and built-in projections", icon: ChartBarSquareIcon },
];

const frameworks = [
	{
		name: "Express",
		svg: (
			<path d="M24 18.588a1.529 1.529 0 01-1.895-.72l-3.45-4.771-.5-.667-4.003 5.444a1.466 1.466 0 01-1.802.708l5.158-6.92-4.798-6.251a1.595 1.595 0 011.9.666l3.576 4.83 3.596-4.81a1.435 1.435 0 011.788-.668L21.708 7.9l-2.522 3.283a.666.666 0 000 .994l4.804 6.412zM.002 11.576l.42-2.075c1.154-4.103 5.858-5.81 9.094-3.27 1.895 1.489 2.368 3.597 2.275 5.973H1.116C.943 16.447 4.005 19.009 7.92 17.7a4.078 4.078 0 002.582-2.876c.207-.666.548-.78 1.174-.588a5.417 5.417 0 01-2.589 3.957 6.272 6.272 0 01-7.306-.933 6.575 6.575 0 01-1.64-3.858c0-.235-.08-.455-.134-.666A88.33 88.33 0 010 11.577zm1.127-.286h9.654c-.06-3.076-2.001-5.258-4.59-5.278-2.882-.04-4.944 2.094-5.071 5.264z" />
		),
	},
	{
		name: "Fastify",
		svg: (
			<path d="M23.245 6.49L24 4.533l-.031-.121-7.473 1.967c.797-1.153.523-2.078.523-2.078s-2.387 1.524-4.193 1.485c-1.804-.04-2.387-.52-5.155.362-2.768.882-3.551 3.59-4.351 4.173-.804.583-3.32 2.477-3.32 2.477l.006.034 2.27-.724s-.622.585-1.945 2.37l-.062-.057.002.011s1.064 1.626 2.107 1.324a2.14 2.14 0 0 0 .353-.147c.419.234.967.463 1.572.525 0 0-.41-.475-.752-1.017l.238-.154.865.318-.096-.812c.003-.003.006-.003.008-.006l.849.311-.105-.738a5.65 5.65 0 0 1 .322-.158l.885-3.345 3.662-2.497-.291.733c-.741 1.826-2.135 2.256-2.135 2.256l-.582.22c-.433.512-.614.637-.764 2.353.348-.088.682-.107.984-.028 1.564.421 2.107 2.307 1.685 2.827-.104.13-.356.354-.673.617H7.77l-.008.514-.065.051h-.645l-.009.504-.17.127c-.607.011-1.373-.518-1.373-.518 0 .481.401 1.225.401 1.225l.07-.034-.061.045s1.625 1.083 2.646.681c.91-.356 3.263-2.213 5.296-3.093l6.15-1.62.811-2.1-4.688 1.235v-1.889l5.5-1.448.811-2.1-6.31 1.662V8.367zm-11.163 4l1.459-.384.02.074-.455 1.179-1.513.398zm.503 2.526l-1.512.398.489-1.266 1.459-.385.02.073zm1.971-.424l-1.513.398.49-1.266 1.459-.385.02.073Z" />
		),
	},
	{
		name: "Hono",
		svg: (
			<path d="M12.445.002a45.529 45.529 0 0 0-5.252 8.146 8.595 8.595 0 0 1-.555-.53 27.796 27.796 0 0 0-1.205-1.542 8.762 8.762 0 0 0-1.251 2.12 20.743 20.743 0 0 0-1.448 5.88 8.867 8.867 0 0 0 .338 3.468c1.312 3.48 3.794 5.593 7.445 6.337 3.055.438 5.755-.333 8.097-2.312 2.677-2.59 3.359-5.634 2.047-9.132a33.287 33.287 0 0 0-2.988-5.59A91.34 91.34 0 0 0 12.615.053a.216.216 0 0 0-.17-.051Zm-.336 3.906a50.93 50.93 0 0 1 4.794 6.552c.448.767.817 1.57 1.108 2.41.606 2.386-.044 4.354-1.951 5.904-1.845 1.298-3.87 1.683-6.072 1.156-2.376-.737-3.75-2.335-4.121-4.794a5.107 5.107 0 0 1 .242-2.266c.358-.908.79-1.774 1.3-2.601l1.446-2.121a397.33 397.33 0 0 0 3.254-4.24Z" />
		),
	},
	{
		name: "Next.js",
		svg: (
			<path d="M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z" />
		),
	},
	{
		name: "Elysia",
		viewBox: "0 0 512 512",
		svg: (
			<>
				<path fillRule="evenodd" clipRule="evenodd" opacity="0.25" d="M424.404 470.816C478.089 423.889 512 354.905 512 278C512 136.615 397.385 22 256 22C114.615 22 0 136.615 0 278C0 352.658 31.9583 419.851 82.9409 466.646L83.1767 465L419.144 355L424.404 470.816Z" />
				<path opacity="0.45" d="M189.915 52.7412L144.5 46L151.303 43.9069C155.402 42.6455 159.248 40.6719 162.662 38.0765L163.73 37.2654C167.845 34.1375 171.12 30.0364 173.259 25.3304C174.414 22.7883 175.224 20.1027 175.665 17.3454L176.173 14.1698C176.72 10.7473 176.692 7.25741 176.09 3.84416C175.834 2.39429 177.279 1.23239 178.64 1.79296L180.498 2.55815C182.829 3.51798 185.084 4.65434 187.242 5.95732L194.965 10.6205C205.229 16.8174 214.226 24.9023 221.48 34.4477L226.616 41.2051C228.529 43.7228 230.783 45.9625 233.313 47.8599C236.088 49.9411 239.164 51.5874 242.435 52.7418L246 54L227.274 54.749C214.785 55.2486 202.278 54.5764 189.915 52.7412Z" />
				<path opacity="0.45" d="M178.321 93.006L191.79 68.3844C191.922 68.143 191.93 67.8528 191.812 67.6042L187.22 57.9361C184.337 51.8673 178.219 48 171.5 48L170.23 47.9562C161.437 47.653 152.704 46.3829 144.188 44.169L142.504 43.731C135.521 41.9153 128.746 39.3732 122.293 36.1463L119.446 34.723C115.159 32.5797 111.099 30.012 107.325 27.0584L103.55 24.1043C102.428 23.2265 100.803 23.4506 99.9606 24.5992C97.3651 28.1384 95.7379 32.2935 95.2395 36.6541L94.5535 42.6571C94.1854 45.8774 94.1446 49.1267 94.4316 52.3552L96.1031 71.1595C97.3467 85.1501 102.175 98.584 110.123 110.165L111.825 112.645C114.267 116.203 117.113 119.466 120.306 122.369C120.756 122.778 121.329 123.03 121.936 123.084C145.029 125.156 167.194 113.348 178.321 93.006Z" />
				<path opacity="0.7" d="M127.378 123.538L143.376 116.613C150.438 113.557 152.588 104.577 147.676 98.6533C143.683 93.8378 136.58 93.0803 131.661 96.9453L127.867 99.9256C126.958 100.64 126.127 101.448 125.387 102.336L116.263 113.284C114.982 114.822 115.084 117.084 116.5 118.5L119.318 121.721C119.77 122.237 120.296 122.685 120.878 123.049C122.833 124.271 125.263 124.453 127.378 123.538Z" />
				<path opacity="0.55" d="M147.988 44.8437L147.5 45L148.962 45.4651C155.294 47.4798 161.861 48.66 168.498 48.9761C168.83 48.9919 169.163 48.9534 169.483 48.8619L172.5 48L174 47.5L164.419 45.4172C163.158 45.1431 161.982 44.5687 160.991 43.7426C160.218 43.0981 160.223 41.9084 161.002 41.2708L162.423 40.1084C164.12 38.7197 165.493 36.976 166.444 35C160.934 39.3642 154.682 42.6988 147.988 44.8437Z" />
				<path d="M202.776 219.428L72.2905 452.693C71.643 453.851 70.0687 454.069 69.1308 453.131L66.5 450.5L55.5 438L48.4888 428.927C41.8407 420.323 35.9052 411.192 30.7414 401.624L29.7434 399.775C24.2581 389.611 19.6635 378.991 16.0112 368.034L12.5 357.5C7.22519 338.379 6.01447 318.365 8.94583 298.747L9.06961 297.919C10.354 289.323 12.4034 280.86 15.1935 272.629L21 255.5L25.3334 246.385C32.0537 232.249 41.3193 219.472 52.6669 208.691L58.1719 203.462C69.5529 192.65 83.3937 184.769 98.5 180.5C94.967 181.498 91.3608 182.216 87.7149 182.647L80.5 183.5L75 184L69 185L63 185.561L59 186L56.1186 186.18C55.1927 186.238 54.7576 185.057 55.4998 184.5L55.5002 184.5L59.5273 182.57C72.5066 176.351 83.1766 166.172 90 153.5L94.4475 146.562C99.7511 138.288 106.807 131.28 115.116 126.032L116.833 124.948C119.935 122.989 123.246 121.384 126.705 120.163L142.446 114.607C145.348 113.583 147.69 111.39 148.903 108.561L149.143 108C149.705 106.687 149.932 105.255 149.803 103.833C149.608 101.689 148.616 99.6966 147.023 98.2485L144.256 95.7328C144.086 95.5779 143.93 95.4073 143.792 95.2232L126 71.5L111.803 51.9315C108.994 48.0592 107.359 43.4599 107.094 38.6832C107.051 37.9263 107.836 37.4015 108.52 37.7295L123.881 45.1028C137.174 51.4834 152.33 52.825 166.537 48.8786C169.84 47.9612 173.214 47.3242 176.624 46.9745L183.675 46.2513C201.406 44.4328 219.32 45.9054 236.516 50.5953L238 51L254.798 57.0472C275.869 64.6329 292.567 81.0571 300.5 102L304.022 115.734C305.004 119.567 306.392 123.285 308.162 126.824C312.321 135.142 318.495 142.289 326.121 147.613L335.084 153.87C339.023 156.62 343.157 159.078 347.453 161.227L367.289 171.145C368.178 171.589 368.444 172.732 367.843 173.523C362.372 180.721 355.148 186.395 346.859 190.005L335.371 195.008C330.797 197 326.081 198.65 321.262 199.945L312.822 202.212C300.992 205.39 288.796 207 276.546 207H256.333C252.148 207 248.001 206.213 244.108 204.679C228.581 198.562 210.923 204.863 202.776 219.428Z" />
				<path opacity="0.85" d="M271.185 135.316L279.987 135.418C281.182 135.432 281.452 133.748 280.312 133.388C278.441 132.797 276.623 132.048 274.879 131.15L268.008 127.61C263.35 125.211 258.969 122.308 254.944 118.953L253.592 117.827C250.54 115.283 247.77 112.418 245.33 109.282L243.768 107.273C243.234 106.586 242.134 107.005 242.192 107.873C243.212 123.186 255.839 135.138 271.185 135.316Z" />
				<path opacity="0.45" d="M82.2231 456.395L231.313 323.4C245.367 310.863 257.58 296.403 267.59 280.45L268.5 279C273.404 269.192 275.497 258.217 274.547 247.293L273.24 232.258C272.436 223.009 268.618 214.28 262.373 207.41C262.131 207.144 261.81 206.961 261.457 206.889L237.5 202C220.117 196.752 201.688 195.995 183.933 199.8L183 200L169.06 203.259C128.405 212.763 92.5742 236.685 68.2116 270.592L67.597 271.447C60.8846 280.789 55.1822 290.817 50.5856 301.362L49.765 303.245C38.1544 329.881 34.2409 359.238 38.4684 387.985L39.8511 397.387C41.2751 407.07 44.1931 416.474 48.5011 425.262C52.4798 433.379 57.6014 440.883 63.7095 447.547L71.3177 455.847C74.1911 458.981 79.0498 459.225 82.2231 456.395Z" />
				<path opacity="0.35" d="M212.749 278.858L212.267 279.133C199.686 286.322 192.918 299.892 193.58 314.367C193.768 318.484 197.893 322.255 201.858 321.132L209.163 319.062C218.607 316.386 227.353 311.681 234.789 305.274L256 287L262.292 282.343C298.871 255.269 344.833 244.113 389.754 251.405C391.14 251.63 391.184 253.607 389.81 253.894L384.5 255L382.093 255.842C377.15 257.572 372.856 260.776 369.79 265.022C369.214 265.819 369.982 266.89 370.922 266.601L372.663 266.065C382.467 263.049 392.751 261.904 402.978 262.691L407 263C428.843 263.95 449.114 274.626 462.254 292.1L467.179 298.65C481.776 318.063 487.953 342.53 484.319 366.545L482.421 379.087C479.837 396.163 473.618 412.486 464.184 426.952L463.5 428L453 442L441.5 455L430.965 465.114C421.346 474.348 410.827 482.597 399.567 489.738L396 492L389.175 495.25C387.417 496.087 385.95 493.678 387.5 492.5L397 483.5L398.953 481.449C404.232 475.906 408.027 469.12 409.986 461.721L410.889 458.309C411.295 456.776 411.5 455.174 411.5 453.588C411.5 444.909 405.354 437.298 396.836 435.631C391.554 434.597 386.085 435.962 381.907 439.356L372.5 447L355.894 460.587C344.995 469.504 333.185 477.245 320.66 483.682L303.5 492.5L274.5 503.5L268.412 505.16C257.822 508.049 247.012 510.06 236.092 511.174L228 512H202L167.5 508.25L148.832 504.21C138.985 502.079 129.456 498.682 120.482 494.103C113.181 490.378 106.293 485.894 99.931 480.725L85.5 469C68.005 455.64 57.0449 435.448 55.3749 413.498L54.5 402L55.5295 385.822C57.134 360.608 66.7911 336.576 83.0792 317.263C89.6652 309.454 97.2376 302.534 105.606 296.675L108.677 294.526C121.458 285.579 135.72 278.961 150.805 274.976L160.947 272.297C174.135 268.813 187.952 268.445 201.307 271.22L211.887 273.418C214.542 273.97 215.103 277.513 212.749 278.858Z" />
			</>
		),
	},
	{
		name: "Fetch API",
		svg: (
			<path d="M21.721 12.752a9.711 9.711 0 0 0-.945-5.003 12.754 12.754 0 0 1-4.339 2.708 18.991 18.991 0 0 1-.214 4.772 17.165 17.165 0 0 0 5.498-2.477ZM14.634 15.55a17.324 17.324 0 0 0 .332-4.647c-.952.227-1.945.347-2.966.347-1.021 0-2.014-.12-2.966-.347a17.515 17.515 0 0 0 .332 4.647 17.385 17.385 0 0 0 5.268 0ZM9.772 17.119a18.963 18.963 0 0 0 4.456 0A17.182 17.182 0 0 1 12 21.724a17.18 17.18 0 0 1-2.228-4.605ZM7.777 15.23a18.87 18.87 0 0 1-.214-4.774 12.753 12.753 0 0 1-4.34-2.708 9.711 9.711 0 0 0-.944 5.004 17.165 17.165 0 0 0 5.498 2.477ZM21.356 14.752a9.765 9.765 0 0 1-7.478 6.817 18.64 18.64 0 0 0 1.988-4.718 18.627 18.627 0 0 0 5.49-2.098ZM2.644 14.752c1.682.971 3.53 1.688 5.49 2.099a18.64 18.64 0 0 0 1.988 4.718 9.765 9.765 0 0 1-7.478-6.816ZM13.878 2.43a9.755 9.755 0 0 1 6.116 3.986 11.267 11.267 0 0 1-3.746 2.504 18.63 18.63 0 0 0-2.37-6.49ZM12 2.276a17.152 17.152 0 0 1 2.805 7.121c-.897.23-1.837.353-2.805.353-.968 0-1.908-.122-2.805-.353A17.151 17.151 0 0 1 12 2.276ZM10.122 2.43a18.629 18.629 0 0 0-2.37 6.49 11.266 11.266 0 0 1-3.746-2.504 9.754 9.754 0 0 1 6.116-3.985Z" />
		),
	},
	{
		name: "Encore",
		viewBox: "0 0 400 378",
		svg: (
			<path d="M297.08 249.069V298.236H102.764V149.88C133.547 143.253 164.116 134.702 193.83 124.228C229.315 111.829 263.732 97.079 297.08 79.7637V134.489C268.863 148.17 239.576 160.141 209.862 170.616C176.3 182.373 141.884 191.779 107.039 199.047V199.475C171.384 193.489 234.66 183.014 297.08 168.478V218.714C234.66 232.823 171.17 242.87 107.039 248.642V249.069H297.08Z" />
		),
	},
];

const securityGroups = [
	{
		tag: "Protect the Money",
		color: "text-accent-rose",
		items: [
			{
				icon: LockClosedIcon,
				title: "No Double-Spending",
				description: "Two transfers from the same account at the same time? They queue safely. Balancing debits auto-cap to available funds. Every error is classified as transient or deterministic so clients know whether to retry.",
			},
			{
				icon: FingerPrintIcon,
				title: "Safe Retries",
				description: "Network glitch? Client crash? Retry the same request and get the original result back. Field-by-field validation catches mismatched parameters — TigerBeetle-inspired idempotency that tells you exactly which field changed.",
			},
			{
				icon: HandRaisedIcon,
				title: "Instant Account Freeze",
				description: "Suspicious activity? One call blocks all transactions immediately. A new append-only version row records the freeze — the reason and actor are permanently in the audit trail.",
			},
			{
				icon: FunnelIcon,
				title: "Spending Limits",
				description: "Cap how much any account can spend per transaction, per day, or per month. Limits are enforced inside the same lock as the transaction.",
			},
		],
	},
	{
		tag: "Prove What Happened",
		color: "text-accent-blue",
		items: [
			{
				icon: ArrowPathIcon,
				title: "Tamper-Proof Ledger",
				description: "Every event is sealed into a cryptographic hash chain with Merkle tree block checkpoints. Generate O(log n) inclusion proofs for any event. Tampering with a single record is detected instantly.",
			},
			{
				icon: ClipboardDocumentListIcon,
				title: "Full Audit Trail",
				description: "Every operation is permanently logged — who did it, what changed, and when. Database triggers enforce immutability: no UPDATE or DELETE on financial tables, ever.",
			},
			{
				icon: ShieldCheckIcon,
				title: "HMAC-Secured Hashes",
				description: "One config key upgrades every hash to HMAC-SHA256 — so even full database access cannot forge a valid audit trail.",
			},
			{
				icon: ArrowsRightLeftIcon,
				title: "Auto Reconciliation",
				description: "A background worker independently recalculates every balance from raw entries, verifies Merkle roots, and flags any discrepancy. Your financial safety net.",
			},
		],
	},
	{
		tag: "Lock Down the API",
		color: "text-accent-amber",
		items: [
			{
				icon: NoSymbolIcon,
				title: "Rate Limiting",
				description: "Built-in throttling with memory, database, or Redis backends. Four presets from lenient to burst protection. Standard headers included.",
			},
			{
				icon: ShieldExclamationIcon,
				title: "Security Headers",
				description: "Every response includes CSP, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy. Secure by default, zero config.",
			},
			{
				icon: GlobeAltIcon,
				title: "CSRF Protection",
				description: "Mutating requests from browsers are validated against a trusted origin list. Server-to-server calls pass through without friction.",
			},
			{
				icon: CheckBadgeIcon,
				title: "Webhook Signatures",
				description: "Outgoing webhooks are signed with HMAC-SHA256. A 5-minute replay window rejects stale payloads, even if the signature is valid.",
			},
		],
	},
	{
		tag: "Protect Sensitive Data",
		color: "text-accent-emerald",
		items: [
			{
				icon: EyeSlashIcon,
				title: "PII Redaction",
				description: "Emails, phone numbers, passwords, and tokens are automatically scrubbed from all log output before reaching your logging system.",
			},
			{
				icon: CircleStackIcon,
				title: "Parameterized Queries",
				description: "No user input ever touches raw SQL. Every database query uses parameterized placeholders, making injection attacks impossible.",
			},
			{
				icon: ClockIcon,
				title: "Data Retention Policies",
				description: "Sensitive operational data is automatically purged on a schedule. You control exactly how long each data type is retained.",
			},
			{
				icon: Cog6ToothIcon,
				title: "Configurable Redact Keys",
				description: "The default redaction covers common PII fields. Add your own keys — credit cards, tax IDs, bank accounts — with a single config option.",
			},
		],
	},
];

const steps = [
	{
		step: "01",
		label: "Configure",
		icon: Cog6ToothIcon,
		color: "text-accent-violet",
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
		icon: UserGroupIcon,
		color: "text-accent-blue",
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
		icon: ArrowsRightLeftIcon,
		color: "text-accent-amber",
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
		icon: ChartBarIcon,
		color: "text-accent-emerald",
		title: (
			<>
				Read <strong>balances</strong>.
			</>
		),
		description:
			"Query balances, list events, generate reports. Replay history from any point in time.",
	},
];

const adaptersList = [
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
		name: "MySQL",
		viewBox: "0 0 32 32",
		svg: (
			<path d="M27.78 23.553a8.849 8.849 0 0 0-3.712.536c-.287.115-.745.115-.785.478.154.153.172.4.307.613a4.467 4.467 0 0 0 .995 1.167c.4.306.8.611 1.225.879.745.461 1.588.728 2.314 1.187.422.268.842.612 1.264.9.21.153.343.4.611.5v-.058a3.844 3.844 0 0 0-.291-.613c-.191-.19-.383-.363-.575-.554a9.118 9.118 0 0 0-1.99-1.932c-.613-.422-1.953-1-2.2-1.7l-.039-.039a7.69 7.69 0 0 0 1.321-.308c.65-.172 1.243-.133 1.912-.3.307-.077.862-.268.862-.268v-.3c-.342-.34-.587-.795-.947-1.116a25.338 25.338 0 0 0-3.122-2.328c-.587-.379-1.344-.623-1.969-.946-.226-.114-.6-.17-.737-.36a7.594 7.594 0 0 1-.776-1.457c-.548-1.04-1.079-2.193-1.551-3.293a20.236 20.236 0 0 0-.965-2.157A19.078 19.078 0 0 0 11.609 5a9.07 9.07 0 0 0-2.421-.776c-.474-.02-.946-.057-1.419-.075A7.55 7.55 0 0 1 6.9 3.485C5.818 2.8 3.038 1.328 2.242 3.277 1.732 4.508 3 5.718 3.435 6.343A8.866 8.866 0 0 1 4.4 7.762c.133.322.171.663.3 1A22.556 22.556 0 0 0 5.687 11.3a8.946 8.946 0 0 0 .7 1.172c.153.209.417.3.474.645a5.421 5.421 0 0 0-.436 1.419 8.336 8.336 0 0 0 .549 6.358c.3.473 1.022 1.514 1.987 1.116.851-.34.662-1.419.908-2.364.056-.229.019-.379.132-.53V19.3s.483 1.061.723 1.6a10.813 10.813 0 0 0 2.4 2.59A3.514 3.514 0 0 1 14 24.657V25h.427A1.054 1.054 0 0 0 14 24.212a9.4 9.4 0 0 1-.959-1.16 24.992 24.992 0 0 1-2.064-3.519c-.3-.6-.553-1.258-.793-1.857-.11-.231-.11-.58-.295-.7a7.266 7.266 0 0 0-.884 1.313 11.419 11.419 0 0 0-.517 2.921c-.073.02-.037 0-.073.038-.589-.155-.792-.792-1.014-1.332a8.756 8.756 0 0 1-.166-5.164c.128-.405.683-1.681.461-2.068-.111-.369-.48-.58-.682-.871a7.767 7.767 0 0 1-.663-1.237C5.912 9.5 5.69 8.3 5.212 7.216a10.4 10.4 0 0 0-.921-1.489A9.586 9.586 0 0 1 3.276 4.22c-.092-.213-.221-.561-.074-.793a.3.3 0 0 1 .259-.252c.238-.212.921.058 1.16.174a9.2 9.2 0 0 1 1.824.967c.258.194.866.685.866.685h.18c.612.133 1.3.037 1.876.21a12.247 12.247 0 0 1 2.755 1.32 16.981 16.981 0 0 1 5.969 6.545c.23.439.327.842.537 1.3.4.94.9 1.9 1.3 2.814a12.578 12.578 0 0 0 1.36 2.564c.286.4 1.435.612 1.952.822a13.7 13.7 0 0 1 1.32.535c.651.4 1.3.861 1.913 1.3.305.23 1.262.708 1.32 1.091" />
		),
	},
	{
		name: "SQLite",
		viewBox: "0 0 24 24",
		svg: (
			<path d="M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561.049.188.1.39.164.703 0 0-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z" />
		),
	},
	{
		name: "Redis",
		viewBox: "0 0 24 24",
		svg: (
			<path d="M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a101 101 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922a4.45 4.45 0 0 1-2.235-.568c1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z" />
		),
	},
];

function LineMarker({ side }: { side: "left" | "right" }) {
	return (
		<div className={`pointer-events-none absolute -bottom-2 hidden lg:block z-30 ${side === "left" ? "left-6 lg:left-12 xl:left-16 -translate-x-1/2" : "right-6 lg:right-12 xl:right-16 translate-x-1/2"}`}>
			<Plus className="size-4 text-border" strokeWidth={1} />
		</div>
	);
}

export default function HomePage() {
	return (
		<main className="min-h-dvh overflow-x-hidden relative bg-background text-foreground">

			{/* Announcement Bar */}
			{/* Hero */}
			<Section className="overflow-y-clip border-b border-dashed border-border" customPaddings id="hero">
				<section className="relative w-full antialiased py-12 sm:py-20 md:py-28 lg:py-36">
					<Spotlight />
					<div className="absolute inset-0 pointer-events-none">
						<div className="absolute inset-0 bg-dot text-foreground/3" />
						<div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,color-mix(in_oklch,var(--brand)_15%,transparent),transparent_70%)]" />
						<div className="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background" />
					</div>

					<LineMarker side="left" />
					<LineMarker side="right" />

					<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 relative z-10 w-full">
						<div className="grid grid-cols-1 items-center gap-10 sm:gap-16 lg:grid-cols-2 lg:gap-24">
							{/* Left — Text */}
							<AnimateIn delay={0} direction="up">
								<div className="relative z-10 max-w-xl">
									<div className="space-y-6 sm:space-y-8">
										<div className="space-y-4 sm:space-y-5">
											<p className="text-xs font-pixel text-brand tracking-widest uppercase">
												Financial Infrastructure for TypeScript
											</p>
											<h1 className="text-foreground tracking-tighter text-3xl sm:text-4xl md:text-5xl lg:text-7xl text-balance font-semibold leading-[1.08]">
												<TextScramble text="Stop building your ledger from scratch." delay={400} />
											</h1>
											<p className="text-muted-foreground text-sm sm:text-base md:text-lg leading-relaxed max-w-md">
												Append-only, double-entry, tamper-proof — the immutable
												financial ledger that grows with your product. From first
												transaction to millions.
											</p>
										</div>

										{/* CTA Buttons */}
										<div className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-center">
											<Link
												href="/docs"
												className="group inline-flex items-center justify-center h-10 px-6 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors"
											>
												Get Started
												<ArrowRight className="size-3.5 ml-2 group-hover:translate-x-0.5 transition-transform" />
											</Link>
											<Link
												href="https://github.com/summa-ledger/summa"
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center justify-center h-10 px-6 text-sm font-medium border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors gap-2"
											>
												<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 496 512" aria-hidden="true">
													<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
												</svg>
												Star on GitHub
											</Link>
										</div>

										{/* Terminal Install */}
										<div className="relative flex items-center w-full sm:w-[90%] border border-[#1a1a1a] bg-[#0a0a0a] rounded-lg overflow-hidden">
											<GradientBG className="w-full flex items-center justify-between gap-3 px-4 py-3">
												<div className="w-full flex items-center gap-2 min-w-0">
													<p className="text-[13px] sm:text-[14px] font-code font-normal select-none shrink-0 antialiased space-x-1">
														<span className="text-blue-600 dark:text-blue-400">git:</span><span className="text-violet-600 dark:text-violet-400">(main)</span>{" "}
														<span className="italic text-blue-500 dark:text-blue-300">x</span>
													</p>
													<p className="relative text-[13px] sm:text-[14px] font-code font-normal text-[#e1e1e1] antialiased">
														<span className="text-[#e1e1e1]">npm i </span>
														<span className="relative text-[#79c0ff]">
															summa
															<span className="absolute h-2 bg-linear-to-tr from-blue-400/20 to-violet-400/10 blur-2xl w-full top-0 left-2" />
														</span>
													</p>
												</div>
												<div className="flex items-center gap-2.5 shrink-0">
													<Link href="https://www.npmjs.com/package/summa" target="_blank" rel="noopener noreferrer" className="text-[#555555] hover:text-[#a0a0a0] transition-colors" aria-label="npm">
														<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 256 256" aria-hidden="true">
															<path fill="#cb3837" d="M0 256V0h256v256z" />
															<path fill="#fff" d="M48 48h160v160h-32V80h-48v128H48z" />
														</svg>
													</Link>
													<Link href="https://github.com/summa-ledger/summa" target="_blank" rel="noopener noreferrer" className="text-[#555555] hover:text-[#a0a0a0] transition-colors" aria-label="GitHub">
														<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 496 512" aria-hidden="true">
															<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
														</svg>
													</Link>
												</div>
											</GradientBG>
										</div>
									</div>
								</div>
							</AnimateIn>

							{/* Right — Code Preview */}
							<AnimateIn delay={0.15} direction="up">
								<div className="relative">
									<CodePreview />
								</div>
							</AnimateIn>
						</div>
					</div>
				</section>
			</Section>

			{/* Value Proposition — Numbered 3-column */}
			<div className="relative border-b border-dashed border-border">
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-brand/25 hidden lg:block" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12">
					<div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
						{[
							{ num: "01", label: "Build Fast", desc: "One config file. Full type inference. From zero to double-entry ledger in minutes, not months.", icon: BoltIcon, color: "text-accent-amber" },
							{ num: "02", label: "Track Every Cent", desc: "Append-only by design. Every mutation inserts a new version row — never an UPDATE, never a DELETE. Rebuild state from any point in time.", icon: DocumentMagnifyingGlassIcon, color: "text-accent-blue" },
							{ num: "03", label: "Trust Your Ledger", desc: "HMAC-SHA256 hash chains, Merkle tree proofs, balance checksums, and database triggers that block mutations. Tamper-proof integrity without the infrastructure tax.", icon: ShieldCheckIcon, color: "text-accent-emerald" },
						].map((item, i) => (
							<AnimateIn key={item.num} delay={i * 0.1}>
								<div className="bg-background py-10 sm:py-16 lg:py-24 px-4 sm:px-6 md:px-10 lg:px-14 h-full">
									<span className="text-5xl sm:text-6xl lg:text-7xl font-extralight tracking-tighter text-foreground/20 font-pixel block mb-4 sm:mb-6">{item.num}</span>
									<item.icon className={`size-5 mb-3 ${item.color}`} />
									<p className="text-sm font-semibold tracking-tight text-foreground mb-3">{item.label}</p>
									<p className="text-sm leading-relaxed text-muted-foreground">{item.desc}</p>
								</div>
							</AnimateIn>
						))}
					</div>
				</div>
			</div>

			{/* How It Works — Numbered divider columns */}
			<Section className="relative border-b border-dashed border-border" customPaddings id="how-it-works">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-violet tracking-widest uppercase mb-4">How It Works</p>
							<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
								From zero to production in four steps.
							</h2>
						</div>
					</AnimateIn>
					<div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
						{steps.map((item, i) => (
							<AnimateIn key={item.step} delay={i * 0.1}>
								<div className="bg-background p-5 sm:p-8 lg:p-10 h-full">
									<span className="text-3xl sm:text-4xl font-extralight tracking-tighter text-foreground/20 font-pixel block mb-3 sm:mb-4">{item.step}</span>
									<item.icon className={`size-5 mb-3 ${item.color}`} />
									<p className="text-xs font-pixel uppercase tracking-wider text-muted-foreground mb-2">{item.label}</p>
									<h3 className="text-base font-semibold tracking-tight mb-2">{item.title}</h3>
									<p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>
								</div>
							</AnimateIn>
						))}
					</div>
				</div>
			</Section>

			{/* Use Cases — 2-col layout: large left card + stacked right */}
			<Section className="relative bg-card border-b border-dashed border-border" customPaddings id="use-cases">
				<div className="pointer-events-none absolute inset-0 bg-dot text-foreground/3" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-card/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-amber tracking-widest uppercase mb-4">Use Cases</p>
							<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
								One ledger.{" "}
								<span className="text-muted-foreground">Every use case.</span>
							</h2>
						</div>
					</AnimateIn>

					<div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
						{useCases.map((useCase, i) => (
							<AnimateIn key={useCase.label} delay={(i % 3) * 0.1}>
								<AccentCard className="p-5 sm:p-8 lg:p-10 h-full">
									<useCase.icon className={`size-5 mb-5 ${useCase.color}`} />
									<p className="text-xs font-pixel uppercase tracking-wider text-muted-foreground mb-2">{useCase.label}</p>
									<p className="text-sm leading-relaxed text-muted-foreground">{useCase.description}</p>
								</AccentCard>
							</AnimateIn>
						))}
					</div>
				</div>
			</Section>

			{/* Features — Hero card top + 5-col grid below */}
			<Section className="relative border-b border-dashed border-border" customPaddings id="features">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-blue tracking-widest uppercase mb-4">Core Features</p>
							<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
								Everything you need.
								<br />
								<span className="text-muted-foreground">Nothing you don't.</span>
							</h2>
						</div>
					</AnimateIn>

					<div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
						{features.map((feature, i) => (
							<AnimateIn key={feature.id} delay={(i % 3) * 0.1}>
								<AccentCard className="p-5 sm:p-8 lg:p-10 h-full">
									<feature.icon className={`size-6 mb-6 ${feature.color}`} />
									<p className="text-xs font-pixel uppercase tracking-wider text-muted-foreground mb-2">{feature.label}</p>
									<h3 className="text-lg font-semibold tracking-tight md:text-xl">{feature.title}</h3>
									<p className="mt-3 text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
									<Link href={feature.href} className="inline-flex items-center gap-1.5 mt-5 text-sm text-muted-foreground hover:text-foreground transition-colors group/link">
										Learn more
										<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
									</Link>
								</AccentCard>
							</AnimateIn>
						))}
					</div>
				</div>
			</Section>

			{/* Code Examples — Alternating Layout */}
			<Section className="relative bg-card border-b border-dashed border-border" customPaddings id="code-examples">
				<div className="pointer-events-none absolute inset-0 bg-dot text-foreground/3" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-card/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-rose tracking-widest uppercase mb-4">Beyond the Basics</p>
							<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
								Production-grade from day one.
							</h2>
							<p className="mt-4 text-base text-muted-foreground max-w-lg">
								Authorization holds, event replay, and plugin composition — real financial primitives, not toy abstractions.
							</p>
						</div>
					</AnimateIn>

					{/* Module 1: Prose LEFT + Code RIGHT */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border mb-6">
						<AnimateIn direction="left">
							<div className="bg-background p-6 sm:p-10 lg:p-14 flex flex-col justify-center h-full">
								<h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-4">
									Authorization holds<br />for real payment flows.
								</h3>
								<p className="text-base leading-relaxed text-muted-foreground">
									Place holds on funds, then commit or void them later.
									Perfect for hotel reservations, ride-sharing,
									and any pre-authorization workflow.
								</p>
								<div className="mt-8 flex flex-col gap-3.5">
									{["Create holds with expiration dates", "Commit partial or full amounts", "Void unused holds automatically"].map((item) => (
										<div key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
											<div className="flex items-center justify-center size-5 border border-border bg-accent shrink-0">
												<Check className="size-3 text-foreground/50" />
											</div>
											{item}
										</div>
									))}
								</div>
							</div>
						</AnimateIn>
						<AnimateIn direction="right">
							<div className="bg-background p-4 sm:p-6 md:p-10 flex items-center h-full">
								<div className="w-full">
									<CodeExamples defaultTab={0} />
								</div>
							</div>
						</AnimateIn>
					</div>

					{/* Module 2: Code LEFT + Prose RIGHT */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border mb-6">
						<AnimateIn direction="left">
							<div className="bg-background p-4 sm:p-6 md:p-10 flex items-center h-full order-2 lg:order-1">
								<div className="w-full">
									<CodeExamples defaultTab={1} />
								</div>
							</div>
						</AnimateIn>
						<AnimateIn direction="right">
							<div className="bg-background p-6 sm:p-10 lg:p-14 flex flex-col justify-center h-full order-1 lg:order-2">
								<h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-4">
									Full event history,<br />always replayable.
								</h3>
								<p className="text-base leading-relaxed text-muted-foreground">
									Every state change is an append-only event.
									No UPDATEs, no DELETEs — ever. Replay history to
									rebuild state, debug issues, or satisfy compliance audits.
								</p>
								<div className="mt-8 flex flex-col gap-3.5">
									{["Append-only event log with Merkle proofs", "Filter by account, type, or date range", "Rebuild state from any point in time"].map((item) => (
										<div key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
											<div className="flex items-center justify-center size-5 border border-border bg-accent shrink-0">
												<Check className="size-3 text-foreground/50" />
											</div>
											{item}
										</div>
									))}
								</div>
							</div>
						</AnimateIn>
					</div>

					{/* Module 3: Prose LEFT + Code RIGHT — Multi-Currency */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border">
						<AnimateIn direction="left">
							<div className="bg-background p-6 sm:p-10 lg:p-14 flex flex-col justify-center h-full">
								<h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-4">
									Cross-currency transfers<br />with automatic FX.
								</h3>
								<p className="text-base leading-relaxed text-muted-foreground">
									Transfer between any currency pair. The FX engine
									resolves rates automatically, caches quotes, and
									tracks realized gain/loss for accounting.
								</p>
								<div className="mt-8 flex flex-col gap-3.5">
									{["Auto-resolved exchange rates with configurable providers", "Rate caching and quote generation", "Realized gain/loss tracking per transaction"].map((item) => (
										<div key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
											<div className="flex items-center justify-center size-5 border border-border bg-accent shrink-0">
												<Check className="size-3 text-foreground/50" />
											</div>
											{item}
										</div>
									))}
								</div>
							</div>
						</AnimateIn>
						<AnimateIn direction="right">
							<div className="bg-background p-4 sm:p-6 md:p-10 flex items-center h-full">
								<div className="w-full">
									<CodeExamples defaultTab={2} />
								</div>
							</div>
						</AnimateIn>
					</div>
				</div>
			</Section>

			{/* AI-Ready — MCP + Agent Integration */}
			<Section className="relative border-b border-dashed border-border" customPaddings id="ai-ready">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-violet tracking-widest uppercase mb-4">AI-Ready</p>
							<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
								Your ledger speaks{" "}
								<span className="text-muted-foreground">to AI agents.</span>
							</h2>
						</div>
					</AnimateIn>

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border">
						<AnimateIn direction="left">
							<div className="bg-background p-6 sm:p-10 lg:p-14 flex flex-col justify-center h-full">
								<div className="flex items-center gap-2.5 mb-6">
									<CpuChipIcon className="size-5 text-accent-violet" />
									<p className="text-xs font-pixel uppercase tracking-wider text-muted-foreground">Model Context Protocol</p>
								</div>
								<h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-4">
									Expose your ledger as<br />MCP tools for any AI.
								</h3>
								<p className="text-base leading-relaxed text-muted-foreground">
									The MCP plugin turns balance queries, transfers, and verification
									into tools that Claude, GPT, or any MCP-compatible agent can call
									directly. No custom glue code required.
								</p>
								<div className="mt-8 flex flex-col gap-3.5">
									{["6 built-in tools — balances, transactions, transfers, verification", "Works with Claude Desktop, custom agents, or any MCP client", "Authorization callback for production security"].map((item) => (
										<div key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
											<div className="flex items-center justify-center size-5 border border-border bg-accent shrink-0">
												<Check className="size-3 text-foreground/50" />
											</div>
											{item}
										</div>
									))}
								</div>
								<Link href="/docs/plugins/mcp" className="inline-flex items-center gap-1.5 mt-8 text-sm text-muted-foreground hover:text-foreground transition-colors group/link">
									MCP plugin docs
									<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
								</Link>
							</div>
						</AnimateIn>
						<AnimateIn direction="right">
							<div className="bg-background p-4 sm:p-6 md:p-10 flex items-center h-full">
								<div className="w-full font-code text-[13px] leading-relaxed">
									<div className="border border-border bg-card p-5 sm:p-6 space-y-4">
										<p className="text-muted-foreground/50 text-xs uppercase tracking-wider mb-4">claude_desktop_config.json</p>
										<pre className="text-sm text-muted-foreground overflow-x-auto"><code>{`{
  "mcpServers": {
    "summa-ledger": {
      "url": "http://localhost:3000/api/ledger/mcp"
    }
  }
}`}</code></pre>
										<div className="border-t border-border pt-4 mt-4">
											<p className="text-muted-foreground/50 text-xs uppercase tracking-wider mb-4">Agent request</p>
											<pre className="text-sm text-muted-foreground overflow-x-auto"><code>{`POST /mcp/tools/call
{
  "name": "summa_transfer",
  "arguments": {
    "sourceHolderId": "user_alice",
    "destinationHolderId": "user_bob",
    "amount": 5000,
    "reference": "Payment for invoice #42"
  }
}`}</code></pre>
										</div>
									</div>
								</div>
							</div>
						</AnimateIn>
					</div>
				</div>
			</Section>

			{/* Plugin Ecosystem — Compact grid */}
			<Section className="relative border-b border-dashed border-border" customPaddings id="plugins">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32">
					<div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-10 sm:mb-16">
						<AnimateIn>
							<div className="max-w-2xl">
								<p className="text-xs font-pixel text-accent-emerald tracking-widest uppercase mb-4">Plugin Ecosystem</p>
								<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
									30 plugins.{" "}
									<span className="text-muted-foreground">Compose what you need.</span>
								</h2>
							</div>
						</AnimateIn>
						<AnimateIn delay={0.1}>
							<Link href="/docs/plugins" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group/link shrink-0">
								Build your own plugin
								<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
							</Link>
						</AnimateIn>
					</div>

					<div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-border border border-border">
						{plugins.map((plugin, i) => (
							<AnimateIn key={plugin.name} delay={Math.min(i, 7) * 0.05}>
								<div className="bg-background p-4 sm:p-6 lg:p-8 group hover:bg-accent/50 transition-colors h-full">
									<div className="flex items-center gap-2.5 mb-3">
										<plugin.icon className="size-4 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors shrink-0" />
										<p className="text-sm font-medium tracking-tight text-foreground">{plugin.name}</p>
									</div>
									<p className="text-xs leading-relaxed text-muted-foreground">{plugin.description}</p>
								</div>
							</AnimateIn>
						))}
						<AnimateIn delay={0.4}>
							<div className="bg-background p-4 sm:p-6 lg:p-8 flex flex-col items-center justify-center text-center h-full">
								<p className="text-xs text-muted-foreground mb-3">Need something custom?</p>
								<Link href="/docs/plugins" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group/link">
									Build your own
									<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
								</Link>
							</div>
						</AnimateIn>
					</div>
				</div>
			</Section>

			{/* Adapters + Frameworks */}
			<Section className="relative bg-card border-b border-dashed border-border" customPaddings id="adapters">
				<div className="pointer-events-none absolute inset-0 bg-dot text-foreground/3" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-card/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					{/* Database Adapters */}
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-violet tracking-widest uppercase mb-4">Database Adapters</p>
							<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
								Bring your own ORM.{" "}
								<span className="text-muted-foreground">Pick your database.</span>
							</h2>
							<p className="mt-4 text-base text-muted-foreground max-w-lg">
								Drizzle, Prisma, or Kysely. PostgreSQL, MySQL, or SQLite. Swap adapters and SQL dialects without touching business logic.
							</p>
						</div>
					</AnimateIn>
					<div className="grid grid-cols-2 min-[480px]:grid-cols-4 md:grid-cols-7 gap-px bg-border border border-border">
						{adaptersList.map((db, i) => (
							<AnimateIn key={db.name} delay={i * 0.08}>
								<div className="bg-background flex flex-col items-center justify-center p-6 sm:p-8 md:p-12 gap-3 group hover:bg-accent transition-colors duration-200 h-full">
									<svg viewBox={db.viewBox} fill="currentColor" className="size-8 text-foreground/40 group-hover:text-foreground/70 transition-colors duration-200" aria-hidden="true">
										{db.svg}
									</svg>
									<p className="text-muted-foreground text-sm font-medium group-hover:text-foreground/70 transition-colors duration-200">{db.name}</p>
								</div>
							</AnimateIn>
						))}
					</div>

					{/* Framework Integrations */}
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16 mt-14 sm:mt-24">
							<p className="text-xs font-pixel text-accent-blue tracking-widest uppercase mb-4">Framework Integrations</p>
							<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
								Works with your stack.
							</h2>
							<p className="mt-4 text-base text-muted-foreground max-w-lg">
								First-class HTTP handlers for every major framework. Mount the API or use the core programmatically.
							</p>
						</div>
					</AnimateIn>
					<div className="grid grid-cols-2 min-[480px]:grid-cols-3 md:grid-cols-5 gap-px bg-border border border-border">
						{frameworks.map((fw, i) => (
							<AnimateIn key={fw.name} delay={i * 0.08}>
								<div className="bg-background flex flex-col items-center justify-center p-6 sm:p-8 md:p-12 gap-3 group hover:bg-accent transition-colors duration-200 h-full">
									<svg viewBox={fw.viewBox ?? "0 0 24 24"} fill="currentColor" className="size-8 text-foreground/40 group-hover:text-foreground/70 transition-colors duration-200" aria-hidden="true">
										{fw.svg}
									</svg>
									<p className="text-muted-foreground text-sm font-medium group-hover:text-foreground/70 transition-colors duration-200">{fw.name}</p>
								</div>
							</AnimateIn>
						))}
					</div>
				</div>
			</Section>

			{/* Security — 4 themed groups with card grids */}
			<Section className="relative border-b border-dashed border-border" customPaddings id="security">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32">
					<AnimateIn>
						<div className="max-w-2xl mb-10 sm:mb-16">
							<p className="text-xs font-pixel text-accent-rose tracking-widest uppercase mb-4">Security</p>
							<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
								Built like a steel vault.
							</h2>
							<p className="mt-4 text-base text-muted-foreground max-w-lg">
								Financial systems are high-value targets. Security isn't bolted on as an afterthought — it's built into every layer.
							</p>
						</div>
					</AnimateIn>

					<div className="space-y-6">
						{securityGroups.map((group, gi) => (
							<div key={group.tag}>
								<AnimateIn delay={gi * 0.08}>
									<p className={`text-xs font-pixel uppercase tracking-widest mb-4 ${group.color}`}>{group.tag}</p>
								</AnimateIn>
								<div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
									{group.items.map((item, i) => (
										<AnimateIn key={item.title} delay={gi * 0.08 + i * 0.05}>
											<AccentCard className="p-5 sm:p-6 lg:p-8 h-full">
												<item.icon className={`size-5 mb-4 ${group.color}`} />
												<p className="text-sm font-medium tracking-tight text-foreground mb-2">{item.title}</p>
												<p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>
											</AccentCard>
										</AnimateIn>
									))}
								</div>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Open Source — Full-bleed stat counters */}
			<Section className="relative bg-card border-b border-dashed border-border" customPaddings id="open-source">
				<div className="pointer-events-none absolute inset-0 bg-dot text-foreground/3" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-card/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-14 sm:py-20 lg:py-32 relative">
					<div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-12 sm:mb-20">
						<AnimateIn>
							<div className="max-w-2xl">
								<p className="text-xs font-pixel text-accent-amber tracking-widest uppercase mb-4">Open Source</p>
								<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
									Built in the open.
								</h2>
								<p className="mt-4 text-base text-muted-foreground max-w-lg">
									MIT licensed. Read every line, fork it, extend it.
								</p>
							</div>
						</AnimateIn>
						<AnimateIn delay={0.1}>
							<Link
								href="https://github.com/summa-ledger/summa"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group/link shrink-0"
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 496 512" aria-hidden="true">
									<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
								</svg>
								View on GitHub
								<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
							</Link>
						</AnimateIn>
					</div>

					{/* Stats — large numbers in gap-px grid */}
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
						{[
							{ value: <span>MIT</span>, label: "License" },
							{ value: <Counter target={33} />, label: "Plugins" },
							{ value: <Counter target={36} suffix="+" />, label: "Endpoints" },
							{ value: <Counter target={2} />, label: "Runtime deps" },
						].map((stat, i) => (
							<AnimateIn key={stat.label} delay={i * 0.1}>
								<div className="bg-background py-10 sm:py-12 lg:py-16 flex flex-col items-center text-center h-full">
									<p className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tighter text-foreground tabular-nums">
										{stat.value}
									</p>
									<p className="mt-3 text-xs font-pixel uppercase tracking-widest text-muted-foreground">{stat.label}</p>
								</div>
							</AnimateIn>
						))}
					</div>
				</div>
			</Section>

			{/* CTA — Dark section with interactive grid */}
			<section
				className="relative overflow-hidden bg-surface-deep"
				id="cta"
				style={{
					"--foreground": "oklch(0.93 0 0)",
					"--muted-foreground": "oklch(0.6 0 0)",
					"--border": "oklch(0.28 0 0)",
					"--brand": "oklch(0.68 0.14 255)",
					"--primary-foreground": "oklch(0.145 0 0)",
					"--accent": "oklch(0.22 0 0)",
				} as React.CSSProperties}
			>
				<InteractiveGrid />

				{/* Radial fade so text is readable over the grid */}
				<div className="pointer-events-none absolute inset-0 z-2 bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,var(--surface-deep)_0%,transparent_75%)]" style={{ opacity: 0.9 }} />

				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12 py-24 sm:py-36 lg:py-48 relative z-10">
					{/* Two-row layout: headline row + action row */}
					<AnimateIn>
						<div className="flex flex-col items-center gap-16 sm:gap-20">

							{/* Top: headline + description */}
							<div className="flex flex-col items-center text-center gap-5">
								<p className="text-xs font-pixel text-brand tracking-widest uppercase">
									Open Source &middot; MIT Licensed
								</p>
								<h2 className="max-w-3xl text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tighter text-foreground leading-[1.1]">
									Your ledger should be the last thing you worry about.
								</h2>
								<p className="text-muted-foreground text-base md:text-lg max-w-xl leading-relaxed">
									Double-entry bookkeeping, Merkle-proofed audit trails, overdraft controls, multi-currency, and 34 plugins — all in a single <code className="text-[0.9em] font-code text-foreground/80">npm&nbsp;install</code>.
								</p>
							</div>

							{/* Bottom: terminal + buttons side-by-side on desktop, stacked on mobile */}
							<div className="flex flex-col sm:flex-row items-center gap-4 w-full max-w-lg">
								{/* Terminal install */}
								<div className="relative flex items-center w-full sm:flex-1 border border-[oklch(0.25_0_0)] bg-[oklch(0.09_0_0)] rounded-lg overflow-hidden">
									<GradientBG className="w-full flex items-center gap-3 px-4 py-3">
										<p className="text-[13px] sm:text-[14px] font-code font-normal text-[#e1e1e1] antialiased">
											<span className="text-muted-foreground select-none">$&nbsp;</span>
											<span className="text-[#e1e1e1]">npm i </span>
											<span className="relative text-[#79c0ff]">
												summa
												<span className="absolute h-2 bg-linear-to-tr from-blue-400/20 to-violet-400/10 blur-2xl w-full top-0 left-2" />
											</span>
										</p>
									</GradientBG>
								</div>

								{/* Divider */}
								<span className="hidden sm:block text-muted-foreground/40 text-xs font-pixel select-none">or</span>

								{/* Buttons */}
								<div className="flex items-center gap-3">
									<Link
										href="/docs"
										className="group inline-flex items-center justify-center h-10 px-5 py-2 text-sm font-medium uppercase tracking-widest bg-brand text-primary-foreground hover:bg-brand/90 transition-colors whitespace-nowrap"
									>
										Get Started
										<ArrowRight className="size-3.5 ml-2 group-hover:translate-x-0.5 transition-transform" />
									</Link>
									<Link
										href="https://github.com/summa-ledger/summa"
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center justify-center size-10 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
										aria-label="Star on GitHub"
									>
										<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 496 512" aria-hidden="true">
											<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
										</svg>
									</Link>
								</div>
							</div>
						</div>
					</AnimateIn>
				</div>
			</section>

			{/* Footer — TigerBeetle radial gradient + Bastion two-section layout */}
			<footer
				className="relative"
				style={{
					background: "radial-gradient(50% 100% at 50% 0%, var(--surface-footer-from) 0%, var(--surface-footer-to) 100%)",
					"--foreground": "oklch(0.93 0 0)",
					"--muted-foreground": "oklch(0.6 0 0)",
					"--border": "oklch(0.28 0 0)",
					"--heading-secondary": "oklch(0.93 0 0)",
					"--accent": "oklch(0.22 0 0)",
				} as React.CSSProperties}
			>
				{/* Top border — subtle white like TigerBeetle */}
				<div className="absolute inset-x-0 top-0 h-px bg-border" />

				<div className="max-w-400 mx-auto px-4 sm:px-6 lg:px-12">
					{/* Main footer: Bastion-style two-section with divider */}
					<div className="flex flex-col lg:flex-row py-10 sm:py-16 lg:py-20 gap-10 sm:gap-12 lg:gap-0">
						{/* Left section — Brand + description */}
						<div className="lg:flex-3 lg:pr-12">
							<div className="flex items-center gap-2.5 mb-5 text-foreground">
								<svg width="60" height="60" viewBox="0 0 60 60" fill="none" className="size-6" aria-hidden="true">
									<path d="M12 8H48V16H24L34 30L24 44H48V52H12V44L26 30L12 16V8Z" fill="currentColor" />
								</svg>
								<span className="text-lg font-semibold tracking-tight">Summa</span>
							</div>
							<p className="text-sm leading-relaxed max-w-sm text-muted-foreground/70">
								Immutable, append-only, double-entry financial ledger for TypeScript.
								MIT licensed. Zero vendor lock-in.
							</p>

							{/* Social icons — Formance-style pill backgrounds */}
							<div className="mt-8 flex items-center gap-3">
								<Link href="https://github.com/summa-ledger/summa" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center size-8 bg-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" aria-label="GitHub">
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 496 512" fill="currentColor" aria-hidden="true">
										<path d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
									</svg>
								</Link>
								<Link href="https://www.npmjs.com/package/summa" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center size-8 bg-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" aria-label="npm">
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" aria-hidden="true">
										<path fill="currentColor" d="M0 256V0h256v256z" />
										<path fill="var(--surface-footer-to)" d="M48 48h160v160h-32V80h-48v128H48z" />
									</svg>
								</Link>
							</div>
						</div>

						{/* Vertical divider — Bastion style */}
						<div className="hidden lg:block w-px bg-border shrink-0" />

						{/* Right section — Navigation columns */}
						<div className="lg:flex-4 lg:pl-12">
							{/* Link group with Bastion spotlight hover */}
							<div className="group/footernav grid grid-cols-2 md:grid-cols-4 gap-8 lg:gap-8">
								<div>
									<p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-heading-secondary mb-5">Documentation</p>
									<ul className="space-y-2.5">
										<li><Link href="/docs" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Getting Started</Link></li>
										<li><Link href="/docs/configuration" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Configuration</Link></li>
										<li><Link href="/docs/api-reference" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">API Reference</Link></li>
									</ul>
								</div>

								<div>
									<p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-heading-secondary mb-5">Product</p>
									<ul className="space-y-2.5">
										<li><Link href="/docs/plugins" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Plugins</Link></li>
										<li><Link href="/docs/adapters/drizzle" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Adapters</Link></li>
										<li><Link href="/docs/cli" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">CLI</Link></li>
										<li><Link href="/docs/plugins/mcp" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">MCP</Link></li>
										<li><Link href="/docs/openapi-viewer" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">OpenAPI</Link></li>
									</ul>
								</div>

								<div>
									<p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-heading-secondary mb-5">Resources</p>
									<ul className="space-y-2.5">
										<li><Link href="/docs/transactions" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Transactions</Link></li>
										<li><Link href="/docs/holds" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Holds</Link></li>
										<li><Link href="/docs/events" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Events</Link></li>
										<li><Link href="/docs/accounts" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">Accounts</Link></li>
									</ul>
								</div>

								<div>
									<p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-heading-secondary mb-5">Connect</p>
									<ul className="space-y-2.5">
										<li><Link href="https://github.com/summa-ledger/summa" target="_blank" rel="noopener noreferrer" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">GitHub</Link></li>
										<li><Link href="https://www.npmjs.com/package/summa" target="_blank" rel="noopener noreferrer" className="text-sm leading-8 text-muted-foreground group-hover/footernav:text-muted-foreground/50 hover:text-foreground! transition-colors">npm</Link></li>
									</ul>
								</div>
							</div>
						</div>
					</div>

					{/* Sub-footer — Formance-style darker bottom bar */}
					<div className="border-t border-border py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
						<div className="flex items-center gap-6 text-muted-foreground">
							<svg width="60" height="60" viewBox="0 0 60 60" fill="none" className="size-4 opacity-40" aria-hidden="true">
								<path d="M12 8H48V16H24L34 30L24 44H48V52H12V44L26 30L12 16V8Z" fill="currentColor" />
							</svg>
							<p className="text-xs text-muted-foreground/50">
								&copy; {new Date().getFullYear()} Summa. All rights reserved.
							</p>
						</div>
						<div className="flex items-center gap-5">
							<Link href="https://github.com/summa-ledger/summa/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">MIT License</Link>
							<span className="text-border">|</span>
							<Link href="/docs" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">Documentation</Link>
						</div>
					</div>
				</div>
			</footer>
		</main>
	);
}
