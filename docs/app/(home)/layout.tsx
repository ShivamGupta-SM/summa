import type { ReactNode } from "react";
import { Navbar } from "@/components/nav-bar";
import { NavbarProvider } from "@/components/nav-mobile";

export default function HomeLayout({ children }: { children: ReactNode }) {
	return (
		<NavbarProvider>
			<div className="relative">
				{/* Structural vertical lines — dashed, full page height */}
				<div className="pointer-events-none absolute inset-y-0 left-6 w-px z-40 hidden lg:block lg:left-12 xl:left-16 border-l border-dashed border-border" />
				<div className="pointer-events-none absolute inset-y-0 right-6 w-px z-40 hidden lg:block lg:right-12 xl:right-16 border-r border-dashed border-border" />

				{/* Animated brand lines — solid, grow on page load */}
				<div className="pointer-events-none absolute inset-y-0 left-6 lg:left-12 xl:left-16 w-px z-40 hidden lg:block origin-top animate-line-grow bg-brand/25" />
				<div className="pointer-events-none absolute inset-y-0 right-6 lg:right-12 xl:right-16 w-px z-40 hidden lg:block origin-top animate-line-grow-delayed bg-brand/25" />

				<Navbar />
				{children}
			</div>
		</NavbarProvider>
	);
}
