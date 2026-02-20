import { RootProvider } from "fumadocs-ui/provider/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { Navbar } from "@/components/nav-bar";
import { NavbarProvider } from "@/components/nav-mobile";
import { baseUrl, createMetadata } from "@/lib/metadata";
import "./global.css";

export const metadata = createMetadata({
	title: {
		template: "%s | Summa",
		default: "Summa",
	},
	description:
		"Event-sourced double-entry financial ledger for TypeScript.",
	metadataBase: baseUrl,
});

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body
				className={`${GeistSans.variable} ${GeistMono.variable} bg-background font-sans relative`}
			>
				<RootProvider
					theme={{
						defaultTheme: "dark",
					}}
				>
					<NavbarProvider>
						<Navbar />
						{children}
					</NavbarProvider>
				</RootProvider>
			</body>
		</html>
	);
}
