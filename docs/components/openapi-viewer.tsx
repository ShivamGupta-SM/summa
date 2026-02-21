"use client";

import { useEffect, useRef } from "react";

interface OpenApiViewerProps {
	specUrl?: string;
}

export function OpenApiViewer({ specUrl = "/api/ledger/openapi.json" }: OpenApiViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const script = document.createElement("script");
		script.id = "scalar-api-reference";
		script.type = "application/json";
		script.textContent = JSON.stringify({
			url: specUrl,
			theme: "kepler",
			darkMode: true,
			hideDownloadButton: false,
			metaData: {
				title: "Summa API Reference",
			},
		});
		containerRef.current.appendChild(script);

		const cdnScript = document.createElement("script");
		cdnScript.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
		containerRef.current.appendChild(cdnScript);

		return () => {
			if (containerRef.current) {
				containerRef.current.innerHTML = "";
			}
		};
	}, [specUrl]);

	return (
		<div
			ref={containerRef}
			className="not-prose w-full min-h-[80vh] rounded-lg border border-fd-border overflow-hidden"
		/>
	);
}
