import type { ReactNode } from "react";
import { Navbar } from "@/components/nav-bar";
import { NavbarProvider } from "@/components/nav-mobile";

export default function HomeLayout({ children }: { children: ReactNode }) {
	return (
		<NavbarProvider>
			<Navbar />
			{children}
		</NavbarProvider>
	);
}
