"use client";

import { animate, useInView, useMotionValue, useTransform, motion } from "framer-motion";
import { useEffect, useRef } from "react";

interface CounterProps {
	target: number;
	suffix?: string;
	prefix?: string;
	duration?: number;
	className?: string;
}

export function Counter({
	target,
	suffix = "",
	prefix = "",
	duration = 1.5,
	className,
}: CounterProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const isInView = useInView(ref, { once: true, margin: "-40px" });
	const count = useMotionValue(0);
	const rounded = useTransform(count, (v) => Math.round(v));

	useEffect(() => {
		if (!isInView) return;
		const controls = animate(count, target, {
			duration,
			ease: [0.16, 1, 0.3, 1],
		});
		return controls.stop;
	}, [isInView, target, duration, count]);

	return (
		<span ref={ref} className={className}>
			{prefix}
			<motion.span>{rounded}</motion.span>
			{suffix}
		</span>
	);
}
