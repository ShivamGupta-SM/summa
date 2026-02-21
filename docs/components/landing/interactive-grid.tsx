"use client";

import { useCallback, useEffect, useRef } from "react";

const COLS = 32;
const ROWS = 12;
const BASE_ANGLE = 45;
const TOTAL = COLS * ROWS;

export function InteractiveGrid() {
	const containerRef = useRef<HTMLDivElement>(null);
	const linesRef = useRef<HTMLSpanElement[]>([]);
	const positionsRef = useRef<{ x: number; y: number }[]>([]);
	const rafRef = useRef<number>(0);
	const mouseRef = useRef({ x: 0, y: 0 });

	const cachePositions = useCallback(() => {
		positionsRef.current = linesRef.current.map((line) => {
			if (!line) return { x: 0, y: 0 };
			const rect = line.getBoundingClientRect();
			return {
				x: rect.left,
				y: rect.top + rect.height / 2,
			};
		});
	}, []);

	const updateLines = useCallback(() => {
		const { x: mouseX, y: mouseY } = mouseRef.current;
		const positions = positionsRef.current;

		for (let i = 0; i < TOTAL; i++) {
			const line = linesRef.current[i];
			const pos = positions[i];
			if (!line || !pos) continue;

			const angle =
				Math.atan2(mouseY - pos.y, mouseX - pos.x) * (180 / Math.PI) - 90;
			line.style.transform = `rotate(${angle}deg)`;
		}
	}, []);

	const handlePointerMove = useCallback(
		(e: PointerEvent) => {
			mouseRef.current = { x: e.clientX, y: e.clientY };
			cancelAnimationFrame(rafRef.current);
			rafRef.current = requestAnimationFrame(updateLines);
		},
		[updateLines],
	);

	useEffect(() => {
		const timer = setTimeout(cachePositions, 100);
		window.addEventListener("resize", cachePositions);
		window.addEventListener("scroll", cachePositions);
		window.addEventListener("pointermove", handlePointerMove);

		return () => {
			clearTimeout(timer);
			window.removeEventListener("resize", cachePositions);
			window.removeEventListener("scroll", cachePositions);
			window.removeEventListener("pointermove", handlePointerMove);
			cancelAnimationFrame(rafRef.current);
		};
	}, [handlePointerMove, cachePositions]);

	const setLineRef = useCallback(
		(index: number) => (el: HTMLSpanElement | null) => {
			if (el) linesRef.current[index] = el;
		},
		[],
	);

	return (
		<div
			ref={containerRef}
			className="pointer-events-none absolute inset-0 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-1 aspect-square grid place-items-center overflow-hidden"
			style={{
				gridTemplateColumns: `repeat(${COLS}, 1fr)`,
				gridTemplateRows: `repeat(${ROWS}, 1fr)`,
				width: "100%",
				height: "100%",
			}}
		>
			{Array.from({ length: TOTAL }, (_, i) => (
				<span
					key={i}
					ref={setLineRef(i)}
					className="block origin-left"
					style={{
						backgroundColor: "var(--muted-foreground)",
						width: "0.1vmin",
						height: "2.5vmin",
						transform: `rotate(${BASE_ANGLE}deg)`,
						willChange: "transform",
					}}
				/>
			))}
		</div>
	);
}
