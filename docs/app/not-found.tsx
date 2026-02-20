import Link from "next/link";
import Section from "@/components/landing/section";
import { Logo } from "@/components/logo";

export default function NotFound() {
	return (
		<div className="h-full relative overflow-hidden">
			<Section
				className="mb-1 h-[92.3vh] overflow-y-hidden"
				customPaddings
				id="404"
			>
				<div className="relative flex flex-col h-full items-center justify-center bg-background text-foreground">
					<div className="relative mb-8">
						<Logo className="w-10 h-10" />
					</div>
					<h1 className="text-8xl font-normal">404</h1>
					<p className="text-sm mb-8">Need help? Visit the docs</p>
					<div className="flex flex-col items-center gap-6">
						<Link
							href="/docs"
							className="px-6 py-2 text-sm font-medium tracking-wide uppercase bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200 md:px-8"
						>
							Go to docs
						</Link>
					</div>
				</div>
			</Section>
		</div>
	);
}
