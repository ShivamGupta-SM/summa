import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Summa",
		short_name: "Summa",
		description:
			"Event-sourced double-entry financial ledger for TypeScript.",
		start_url: "/",
		display: "browser",
		background_color: "#0a0c14",
		theme_color: "#34d399",
		icons: [
			{
				src: "/icon.svg",
				sizes: "any",
				type: "image/svg+xml",
			},
			{
				src: "/icon-192x192.png",
				sizes: "192x192",
				type: "image/png",
			},
			{
				src: "/icon-512x512.png",
				sizes: "512x512",
				type: "image/png",
			},
		],
	};
}
