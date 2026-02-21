import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import { Logo } from "@/components/logo";

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<DocsLayout
			tree={source.pageTree}
			nav={{
				title: (
					<>
						<Logo className="size-5" />
						<span className="font-semibold">Summa</span>
					</>
				),
			}}
			links={[
				{
					text: "Home",
					url: "/",
					active: "url",
				},
				{
					text: "Docs",
					url: "/docs",
					active: "nested-url",
				},
			]}
			githubUrl="https://github.com/summa-ledger/summa"
		>
			{children}
		</DocsLayout>
	);
}
