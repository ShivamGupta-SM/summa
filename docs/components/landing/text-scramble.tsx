"use client";

import { useEffect, useRef, useState } from "react";

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";
const FRAME_RATE = 30;
const CHARS_PER_FRAME = 3;

interface TextScrambleProps {
	text: string;
	className?: string;
	delay?: number;
}

export function TextScramble({ text, className, delay = 0 }: TextScrambleProps) {
	const [display, setDisplay] = useState(text);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		const startTimeout = setTimeout(() => {
			let lockedCount = 0;
			timerRef.current = setInterval(() => {
				lockedCount += CHARS_PER_FRAME;
				const next = text
					.split("")
					.map((char, i) => {
						if (char === " ") return " ";
						if (i < lockedCount) return char;
						return CHARSET[Math.floor(Math.random() * CHARSET.length)];
					})
					.join("");
				setDisplay(next);
				if (lockedCount >= text.length) {
					if (timerRef.current) clearInterval(timerRef.current);
					setDisplay(text);
				}
			}, FRAME_RATE);
		}, delay);

		return () => {
			clearTimeout(startTimeout);
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [text, delay]);

	return <span className={className}>{display}</span>;
}
