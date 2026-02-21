import {
	ArrowPathIcon,
	BanknotesIcon,
	BuildingStorefrontIcon,
	CheckCircleIcon,
	CircleStackIcon,
	CodeBracketSquareIcon,
	CreditCardIcon,
	CubeTransparentIcon,
	CurrencyDollarIcon,
	FingerPrintIcon,
	LockClosedIcon,
	ShieldCheckIcon,
	ShieldExclamationIcon,
	WalletIcon,
} from "@heroicons/react/24/outline";
import { ArrowRight, Check, Plus } from "lucide-react";
import Link from "next/link";
import { CodeExamples } from "@/components/landing/code-examples";
import { CodePreview } from "@/components/landing/code-preview";
import { GradientBG } from "@/components/landing/gradient-bg";
import Section from "@/components/landing/section";
import { Spotlight } from "@/components/landing/spotlight";

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

const useCases = [
	{
		icon: WalletIcon,
		label: "Digital Wallets",
		description: "User balances, top-ups, peer-to-peer transfers with real-time balance tracking and holds.",
	},
	{
		icon: CreditCardIcon,
		label: "Payment Processing",
		description: "Authorization holds, capture/void flows, multi-currency settlements with idempotent operations.",
	},
	{
		icon: BuildingStorefrontIcon,
		label: "Marketplace Payouts",
		description: "Split payments, escrow accounts, seller disbursements with multi-destination transfers.",
	},
	{
		icon: BanknotesIcon,
		label: "Lending & Credit",
		description: "Loan disbursement, repayment tracking, interest accrual with scheduled transactions.",
	},
	{
		icon: CurrencyDollarIcon,
		label: "SaaS Billing",
		description: "Usage-based metering, prepaid credits, subscription lifecycle with velocity limits.",
	},
	{
		icon: CubeTransparentIcon,
		label: "Crypto & DeFi",
		description: "On-chain reconciliation, multi-asset tracking, atomic swaps with event-sourced audit trails.",
	},
];

const plugins = [
	{ name: "Audit Log", description: "Immutable event log for every mutation" },
	{ name: "Reconciliation", description: "Match external transactions to internal entries" },
	{ name: "Snapshots", description: "Point-in-time balance snapshots for reporting" },
	{ name: "Velocity Limits", description: "Rate and amount limits per account or holder" },
	{ name: "Hold Expiry", description: "Auto-expire authorization holds after TTL" },
	{ name: "Scheduled Tx", description: "Future-dated transactions with cron triggers" },
	{ name: "Outbox", description: "Transactional outbox pattern for reliable events" },
	{ name: "Dead Letter", description: "Capture and replay failed operations" },
	{ name: "Hot Accounts", description: "Optimized high-throughput account handling" },
	{ name: "Admin", description: "Management API for accounts and operations" },
	{ name: "Statements", description: "Generate account statements in JSON or CSV" },
	{ name: "OpenAPI", description: "Auto-generated API documentation" },
	{ name: "Observability", description: "Metrics, traces, and structured logging" },
	{ name: "Maintenance", description: "Database cleanup and optimization tasks" },
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
		name: "Deno",
		svg: (
			<path d="M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771a12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774a12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305a12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19a12 12 0 0 1-1.25-1.634a12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635" />
		),
	},
];

const securityFeatures = [
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
];

const steps = [
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
		name: "In-Memory",
		viewBox: "0 0 24 24",
		svg: (
			<path d="M16.5 7.5h-9v9h9v-9Z M8.25 2.25a.75.75 0 0 0-.75.75v.75h-.75A2.25 2.25 0 0 0 4.5 6v.75H3.75a.75.75 0 0 0 0 1.5h.75v2.25h-.75a.75.75 0 0 0 0 1.5h.75v2.25h-.75a.75.75 0 0 0 0 1.5h.75V18a2.25 2.25 0 0 0 2.25 2.25h.75v.75a.75.75 0 0 0 1.5 0v-.75h2.25v.75a.75.75 0 0 0 1.5 0v-.75h2.25v.75a.75.75 0 0 0 1.5 0v-.75H18a2.25 2.25 0 0 0 2.25-2.25v-.75h.75a.75.75 0 0 0 0-1.5h-.75v-2.25h.75a.75.75 0 0 0 0-1.5h-.75V8.25h.75a.75.75 0 0 0 0-1.5h-.75V6a2.25 2.25 0 0 0-2.25-2.25h-.75V3a.75.75 0 0 0-1.5 0v.75h-2.25V3a.75.75 0 0 0-1.5 0v.75H8.25V3a.75.75 0 0 0-.75-.75ZM6 6.75A.75.75 0 0 1 6.75 6h10.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V6.75Z" />
		),
	},
];

function LineMarker({ side }: { side: "left" | "right" }) {
	return (
		<div className={`pointer-events-none absolute -bottom-2 hidden lg:block z-30 ${side === "left" ? "left-6 lg:left-12 xl:left-16 -translate-x-1/2" : "right-6 lg:right-12 xl:right-16 translate-x-1/2"}`}>
			<Plus className="size-4 text-zinc-300 dark:text-zinc-700" strokeWidth={1} />
		</div>
	);
}

export default function HomePage() {
	return (
		<main className="min-h-dvh overflow-x-hidden relative bg-background">
			{/* Structural vertical lines — dashed, better-auth style */}
			<div className="pointer-events-none absolute inset-y-0 left-6 w-px z-20 hidden lg:block lg:left-12 xl:left-16 border-l border-dashed border-zinc-200 dark:border-zinc-800" />
			<div className="pointer-events-none absolute inset-y-0 right-6 w-px z-20 hidden lg:block lg:right-12 xl:right-16 border-r border-dashed border-zinc-200 dark:border-zinc-800" />

			{/* Announcement Bar */}
			<div className="relative border-b border-dashed border-zinc-200 dark:border-zinc-800">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto flex items-center justify-center h-10 px-6 lg:px-12">
					<Link
						href="https://github.com/summa-ledger/summa"
						target="_blank"
						rel="noopener noreferrer"
						className="group inline-flex items-center gap-3 text-sm"
					>
						<span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-brand/10 text-brand border border-brand/20">
							New
						</span>
						<span className="text-muted-foreground group-hover:text-foreground transition-colors">
							Summa is now open source
						</span>
						<ArrowRight className="size-3 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
					</Link>
				</div>
			</div>

			{/* Hero */}
			<Section className="overflow-y-clip border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="hero">
				<section className="relative w-full antialiased py-20 md:py-28 lg:py-36">
					<Spotlight />
					<div className="absolute inset-0 pointer-events-none">
						<div className="absolute inset-0 bg-dot text-foreground/5 dark:text-white/3" />
						<div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,oklch(0.55_0.17_160/0.08),transparent_70%)]" />
						<div className="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background" />
					</div>

					<LineMarker side="left" />
					<LineMarker side="right" />

					<div className="max-w-400 mx-auto px-6 lg:px-12 relative z-10 w-full">
						<div className="grid grid-cols-1 items-center gap-16 lg:grid-cols-2 lg:gap-24">
							{/* Left — Text */}
							<div className="relative z-10 max-w-xl">
								<div className="space-y-8">
									<div className="space-y-5">
										<p className="text-sm font-medium text-brand tracking-wide">
											Financial Infrastructure for TypeScript
										</p>
										<h1 className="text-foreground tracking-tighter text-4xl sm:text-5xl md:text-6xl lg:text-7xl text-balance font-semibold leading-[1.08]">
											Stop building your ledger from scratch.
										</h1>
										<p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-md">
											Event-sourced, double-entry, type-safe — the financial
											ledger that grows with your product. From first transaction
											to millions.
										</p>
									</div>

									{/* CTA Buttons */}
									<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
											className="inline-flex items-center justify-center h-10 px-6 text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors gap-2"
										>
											<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 496 512" aria-hidden="true">
												<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
											</svg>
											Star on GitHub
										</Link>
									</div>

									{/* Terminal Install */}
									<div className="relative flex items-center w-full sm:w-[90%] border border-white/10">
										<GradientBG className="w-full flex items-center justify-between gap-2">
											<div className="w-full flex flex-col min-[350px]:flex-row min-[350px]:items-center gap-0.5 min-[350px]:gap-2 min-w-0">
												<p className="text-xs sm:text-sm font-mono select-none tracking-tighter space-x-1 shrink-0">
													<span>
														<span className="text-sky-500">git:</span>
														<span className="text-red-400">(main)</span>
													</span>
													<span className="italic text-emerald-500">x</span>
												</p>
												<p className="relative inline tracking-tight opacity-90 md:text-sm text-xs dark:text-white font-mono text-black">
													npm i{" "}
													<span className="relative dark:text-fuchsia-300 text-fuchsia-800">
														summa
														<span className="absolute h-2 bg-linear-to-tr from-white via-slate-200 to-emerald-200/50 blur-3xl w-full top-0 left-2" />
													</span>
												</p>
											</div>
											<div className="flex items-center gap-2 shrink-0">
												<Link href="https://www.npmjs.com/package/summa" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors" aria-label="npm">
													<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 256 256" aria-hidden="true">
														<path fill="#cb3837" d="M0 256V0h256v256z" />
														<path fill="#fff" d="M48 48h160v160h-32V80h-48v128H48z" />
													</svg>
												</Link>
												<Link href="https://github.com/summa-ledger/summa" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors" aria-label="GitHub">
													<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 496 512" aria-hidden="true">
														<path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
													</svg>
												</Link>
											</div>
										</GradientBG>
									</div>
								</div>
							</div>

							{/* Right — Code Preview */}
							<div className="relative">
								<CodePreview />
							</div>
						</div>
					</div>
				</section>
			</Section>

			{/* Use Cases — inspired by Blnk & TigerBeetle */}
			<Section className="relative border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="use-cases">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Use Cases</p>
						<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
							One ledger.{" "}
							<span className="text-muted-foreground">Every use case.</span>
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							From digital wallets to lending platforms — Summa provides the financial primitives your product needs.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{useCases.map((useCase) => (
							<div key={useCase.label} className="bg-background p-8 lg:p-10 group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
								<div className="flex items-center gap-2.5 mb-5">
									<useCase.icon className="size-5 text-brand" />
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
										{useCase.label}
									</p>
								</div>
								<p className="text-sm leading-relaxed text-muted-foreground">
									{useCase.description}
								</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Features */}
			<Section className="relative bg-zinc-50 dark:bg-zinc-950/80 border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="features">
				<div className="pointer-events-none absolute inset-0 bg-dot text-zinc-300/30 dark:text-zinc-700/15" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32 relative">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Core Features</p>
						<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
							Everything you need.
							<br />
							<span className="text-muted-foreground">Nothing you don't.</span>
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							A purpose-built financial ledger with the primitives you need to move money safely.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{features.map((feature) => (
							<div key={feature.id} className="bg-background p-8 lg:p-10 group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
								<div className="flex items-center gap-2.5 mb-5">
									<feature.icon className="size-5 text-brand" />
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
										{feature.label}
									</p>
								</div>
								<h3 className="text-lg font-semibold tracking-tight md:text-xl">
									{feature.title}
								</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
									{feature.description}
								</p>
								<Link href={feature.href} className="inline-flex items-center gap-1.5 mt-5 text-sm text-brand hover:underline group/link">
									Learn more
									<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
								</Link>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* How It Works */}
			<Section className="relative border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="how-it-works">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32 relative">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">How It Works</p>
						<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
							From zero to production in four steps.
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							Configure once, then start moving money. No boilerplate, no ceremony.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{steps.map((item) => (
							<div key={item.step} className="bg-background p-8 lg:p-10">
								<div className="flex items-center gap-3 mb-5">
									<span className="text-3xl font-extralight tracking-tighter text-brand/25 tabular-nums font-mono">{item.step}</span>
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{item.label}</p>
								</div>
								<h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Code Examples */}
			<Section className="relative bg-zinc-50 dark:bg-zinc-950/80 border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="code-examples">
				<div className="pointer-events-none absolute inset-0 bg-dot text-zinc-300/30 dark:text-zinc-700/15" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32 relative">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Beyond the Basics</p>
						<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
							Production-grade from day one.
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							Authorization holds, event replay, and plugin composition — real financial primitives, not toy abstractions.
						</p>
					</div>
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						<div className="bg-background p-10 lg:p-14 flex flex-col justify-center">
							<h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-4">
								Real financial primitives,<br />not toy abstractions.
							</h3>
							<p className="text-base leading-relaxed text-muted-foreground">
								Authorization holds for payment processors.
								Event replay for audit compliance. Plugin
								composition for velocity limits, reconciliation,
								and snapshots — all type-safe.
							</p>
							<div className="mt-8 flex flex-col gap-3.5">
								{["Authorization holds with commit/void", "Immutable event log with replay", "Composable plugins with type inference"].map((item) => (
									<div key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
										<div className="flex items-center justify-center size-5 border border-brand/30 bg-brand/5 shrink-0">
											<Check className="size-3 text-brand" />
										</div>
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

			{/* Plugin Ecosystem — inspired by Formance's modular story */}
			<Section className="relative border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="plugins">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Plugin Ecosystem</p>
						<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">
							14 plugins.{" "}
							<span className="text-muted-foreground">Compose what you need.</span>
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							Every plugin is opt-in with full type inference. Add audit logs, velocity limits, reconciliation — or build your own.
						</p>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{plugins.map((plugin) => (
							<div key={plugin.name} className="bg-background p-6 lg:p-8 group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
								<div className="flex items-center gap-2 mb-3">
									<div className="size-2 bg-brand/40 group-hover:bg-brand transition-colors" />
									<p className="text-sm font-medium tracking-tight text-foreground">{plugin.name}</p>
								</div>
								<p className="text-xs leading-relaxed text-muted-foreground">{plugin.description}</p>
							</div>
						))}
						<div className="bg-background p-6 lg:p-8 flex flex-col items-center justify-center text-center">
							<p className="text-xs text-muted-foreground mb-3">Need something custom?</p>
							<Link href="/docs/plugins" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline group/link">
								Build your own
								<ArrowRight className="size-3 group-hover/link:translate-x-0.5 transition-transform" />
							</Link>
						</div>
					</div>
				</div>
			</Section>

			{/* Adapters + Frameworks */}
			<Section className="relative bg-zinc-50 dark:bg-zinc-950/80 border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="adapters">
				<div className="pointer-events-none absolute inset-0 bg-dot text-zinc-300/30 dark:text-zinc-700/15" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32 relative">
					{/* Database Adapters */}
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Database Adapters</p>
						<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
							Bring your own ORM.
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							Swap adapters without touching business logic. Same API, same types, any database.
						</p>
					</div>
					<div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{adaptersList.map((db) => (
							<div key={db.name} className="bg-background flex flex-col items-center justify-center p-8 md:p-12 gap-3 group hover:bg-zinc-50/80 dark:hover:bg-zinc-900/40 transition-colors duration-200">
								<svg viewBox={db.viewBox} fill="currentColor" className="size-8 text-foreground/40 group-hover:text-foreground/70 transition-colors duration-200" aria-hidden="true">
									{db.svg}
								</svg>
								<p className="text-muted-foreground text-sm font-medium group-hover:text-foreground/70 transition-colors duration-200">{db.name}</p>
							</div>
						))}
					</div>

					{/* Framework Integrations */}
					<div className="max-w-2xl mb-16 mt-24">
						<p className="text-sm font-medium text-brand mb-4">Framework Integrations</p>
						<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
							Works with your stack.
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							First-class HTTP handlers for every major framework. Mount the API or use the core programmatically.
						</p>
					</div>
					<div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{frameworks.map((fw) => (
							<div key={fw.name} className="bg-background flex flex-col items-center justify-center p-8 md:p-12 gap-3 group hover:bg-zinc-50/80 dark:hover:bg-zinc-900/40 transition-colors duration-200">
								<svg viewBox="0 0 24 24" fill="currentColor" className="size-8 text-foreground/40 group-hover:text-foreground/70 transition-colors duration-200" aria-hidden="true">
									{fw.svg}
								</svg>
								<p className="text-muted-foreground text-sm font-medium group-hover:text-foreground/70 transition-colors duration-200">{fw.name}</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Security */}
			<Section className="relative border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="security">
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Security</p>
						<h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tighter">Trust is not optional.</h2>
						<p className="mt-4 text-base md:text-lg text-muted-foreground max-w-lg">
							Every layer is hardened — from parameterized queries to cryptographic audit trails.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						{securityFeatures.map((item) => (
							<div key={item.label} className="bg-background p-8 lg:p-10 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors">
								<div className="flex items-center gap-2.5 mb-5">
									<item.icon className="size-5 text-brand" />
									<p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{item.label}</p>
								</div>
								<h3 className="text-lg font-semibold tracking-tight md:text-xl">{item.title}</h3>
								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Open Source Stats + Developer Numbers */}
			<Section className="relative bg-zinc-50 dark:bg-zinc-950/80 border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="open-source">
				<div className="pointer-events-none absolute inset-0 bg-dot text-zinc-300/30 dark:text-zinc-700/15" />
				<div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-transparent to-background/60" />
				<LineMarker side="left" />
				<LineMarker side="right" />
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-24 lg:py-32 relative">
					<div className="max-w-2xl mb-16">
						<p className="text-sm font-medium text-brand mb-4">Open Source</p>
						<h2 className="text-3xl md:text-4xl font-semibold tracking-tighter">
							Built in the open.
						</h2>
						<p className="mt-4 text-base text-muted-foreground max-w-lg">
							MIT licensed. Read every line, fork it, extend it. No vendor lock-in, no black boxes.
						</p>
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-zinc-200 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800">
						<div className="bg-background p-10 lg:p-12 text-center">
							<p className="text-4xl md:text-5xl font-semibold tracking-tighter text-foreground">MIT</p>
							<p className="mt-2 text-sm text-muted-foreground">Open source license</p>
						</div>
						<div className="bg-background p-10 lg:p-12 text-center">
							<p className="text-4xl md:text-5xl font-semibold tracking-tighter text-foreground">14</p>
							<p className="mt-2 text-sm text-muted-foreground">Built-in plugins</p>
						</div>
						<div className="bg-background p-10 lg:p-12 text-center">
							<p className="text-4xl md:text-5xl font-semibold tracking-tighter text-foreground">20+</p>
							<p className="mt-2 text-sm text-muted-foreground">API endpoints</p>
						</div>
						<div className="bg-background p-10 lg:p-12 text-center">
							<p className="text-4xl md:text-5xl font-semibold tracking-tighter text-foreground">0</p>
							<p className="mt-2 text-sm text-muted-foreground">External runtime deps</p>
						</div>
					</div>
				</div>
			</Section>

			{/* CTA — Formance-inspired animated design */}
			<Section className="relative overflow-hidden border-b border-dashed border-zinc-200 dark:border-zinc-800" customPaddings id="cta">
				{/* Solid vertical lines — brand color */}
				<div className="pointer-events-none absolute inset-0 z-10">
					<div className="absolute top-0 bottom-0 left-6 lg:left-12 xl:left-16 w-px bg-brand/30" />
					<div className="absolute top-0 bottom-0 right-6 lg:right-12 xl:right-16 w-px bg-brand/30" />
				</div>

				{/* Beam sweep on left line */}
				<div className="pointer-events-none absolute top-0 bottom-0 left-6 lg:left-12 xl:left-16 w-px z-10 overflow-hidden">
					<div className="absolute w-full h-32 animate-beam-sweep bg-linear-to-b from-transparent via-brand to-transparent" />
				</div>
				{/* Beam sweep on right line (offset) */}
				<div className="pointer-events-none absolute top-0 bottom-0 right-6 lg:right-12 xl:right-16 w-px z-10 overflow-hidden">
					<div className="absolute w-full h-32 animate-beam-sweep bg-linear-to-b from-transparent via-brand to-transparent" style={{ animationDelay: "1.5s" }} />
				</div>

				{/* Grid background */}
				<div className="pointer-events-none absolute inset-0 bg-grid-small text-zinc-200/60 dark:text-zinc-800/40" />

				{/* Central glow */}
				<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_50%_50%,oklch(0.55_0.17_160/0.08),transparent_70%)] animate-glow-pulse" />

				{/* Fade to background edges */}
				<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_50%,transparent_30%,var(--background)_80%)]" />

				<div className="max-w-400 mx-auto px-6 lg:px-12 py-32 lg:py-44 relative z-20">
					<div className="flex flex-col items-center text-center gap-8">
						<p className="text-sm font-medium text-brand">
							Start building today
						</p>
						<h2 className="max-w-2xl text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tighter">
							Stop fighting your ledger.
						</h2>
						<p className="text-muted-foreground text-base md:text-lg max-w-md">
							Ship financial infrastructure that's auditable, type-safe,
							and ready for scale — in an afternoon.
						</p>
						<div className="flex flex-col sm:flex-row items-center gap-3 mt-2">
							<Link
								href="/docs"
								className="group inline-flex items-center justify-center h-11 px-8 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors"
							>
								Read the Docs
								<ArrowRight className="size-3.5 ml-2 group-hover:translate-x-0.5 transition-transform" />
							</Link>
							<Link
								href="https://github.com/summa-ledger/summa"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center justify-center h-11 px-8 text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors"
							>
								View on GitHub
							</Link>
						</div>
					</div>
				</div>
			</Section>

			{/* Footer — Bastion-inspired dark, spacious layout */}
			<footer className="relative bg-zinc-950 text-zinc-400 dark:bg-zinc-950">
				<div className="max-w-400 mx-auto px-6 lg:px-12 py-16 lg:py-20">
					<div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-6 lg:gap-8">
						{/* Brand */}
						<div className="col-span-2 sm:col-span-3 lg:col-span-2 mb-4 lg:mb-0">
							<div className="flex items-center gap-2.5">
								<svg width="60" height="60" viewBox="0 0 60 60" fill="none" className="size-5" aria-hidden="true">
									<path d="M12 8H48V16H24L34 30L24 44H48V52H12V44L26 30L12 16V8Z" className="fill-white" />
								</svg>
								<span className="text-sm font-medium tracking-tight text-white">SUMMA.</span>
							</div>
							<p className="mt-4 text-sm leading-relaxed max-w-64">
								Event-sourced, double-entry financial ledger for TypeScript.
							</p>
							{/* Social icons */}
							<div className="mt-6 flex items-center gap-4">
								<Link href="https://github.com/summa-ledger/summa" target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-white transition-colors" aria-label="GitHub">
									<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 496 512" fill="currentColor" aria-hidden="true">
										<path d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8" />
									</svg>
								</Link>
								<Link href="https://www.npmjs.com/package/summa" target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-white transition-colors" aria-label="npm">
									<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256" aria-hidden="true">
										<path fill="currentColor" d="M0 256V0h256v256z" />
										<path fill="#18181b" d="M48 48h160v160h-32V80h-48v128H48z" />
									</svg>
								</Link>
							</div>
						</div>

						{/* Documentation */}
						<div>
							<p className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-5">Documentation</p>
							<ul className="space-y-3">
								<li><Link href="/docs" className="text-sm hover:text-white transition-colors">Getting Started</Link></li>
								<li><Link href="/docs/configuration" className="text-sm hover:text-white transition-colors">Configuration</Link></li>
								<li><Link href="/docs/api-reference" className="text-sm hover:text-white transition-colors">API Reference</Link></li>
							</ul>
						</div>

						{/* Product */}
						<div>
							<p className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-5">Product</p>
							<ul className="space-y-3">
								<li><Link href="/docs/plugins" className="text-sm hover:text-white transition-colors">Plugins</Link></li>
								<li><Link href="/docs/adapters/drizzle" className="text-sm hover:text-white transition-colors">Adapters</Link></li>
								<li><Link href="/docs/cli" className="text-sm hover:text-white transition-colors">CLI</Link></li>
							</ul>
						</div>

						{/* Resources */}
						<div>
							<p className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-5">Resources</p>
							<ul className="space-y-3">
								<li><Link href="/docs/transactions" className="text-sm hover:text-white transition-colors">Transactions</Link></li>
								<li><Link href="/docs/holds" className="text-sm hover:text-white transition-colors">Holds</Link></li>
								<li><Link href="/docs/events" className="text-sm hover:text-white transition-colors">Events</Link></li>
								<li><Link href="/docs/accounts" className="text-sm hover:text-white transition-colors">Accounts</Link></li>
							</ul>
						</div>

						{/* Legal */}
						<div>
							<p className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-5">Legal</p>
							<ul className="space-y-3">
								<li><Link href="https://github.com/summa-ledger/summa/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="text-sm hover:text-white transition-colors">MIT License</Link></li>
							</ul>
						</div>
					</div>

					{/* Bottom bar */}
					<div className="mt-16 pt-8 border-t border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-4">
						<p className="text-xs text-zinc-600">
							&copy; {new Date().getFullYear()} Summa. All rights reserved.
						</p>
						<p className="text-xs text-zinc-600">
							Open source under the MIT License.
						</p>
					</div>
				</div>
			</footer>
		</main>
	);
}
