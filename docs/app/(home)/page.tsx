import Link from "next/link";

export default function HomePage() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 text-center">
			<h1 className="text-4xl font-bold">Summa</h1>
			<p className="max-w-lg text-lg text-fd-muted-foreground">
				Event-sourced double-entry financial ledger for TypeScript.
				Built for correctness, auditability, and developer experience.
			</p>
			<div className="flex gap-4">
				<Link
					href="/docs"
					className="rounded-lg bg-fd-primary px-6 py-3 text-sm font-medium text-fd-primary-foreground"
				>
					Get Started
				</Link>
				<Link
					href="https://github.com/summa-ledger/summa"
					className="rounded-lg border border-fd-border px-6 py-3 text-sm font-medium"
				>
					GitHub
				</Link>
			</div>
		</main>
	);
}
