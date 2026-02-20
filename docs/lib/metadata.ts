import type { Metadata } from "next/types";

export function createMetadata(override: Metadata): Metadata {
	return {
		...override,
		openGraph: {
			title: override.title ?? undefined,
			description: override.description ?? undefined,
			url: "https://summa.dev",
			siteName: "Summa",
			...override.openGraph,
		},
		twitter: {
			card: "summary_large_image",
			title: override.title ?? undefined,
			description: override.description ?? undefined,
			...override.twitter,
		},
	};
}

export { baseUrl } from "./utils";
