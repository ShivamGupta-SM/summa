import "fumadocs-ui/style.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { ReactNode } from "react";

export const metadata = {
	title: "Summa — Event-sourced Financial Ledger",
	description:
		"Type-safe, event-sourced double-entry bookkeeping for TypeScript",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body>
				<RootProvider>{children}</RootProvider>
			</body>
		</html>
	);
}
