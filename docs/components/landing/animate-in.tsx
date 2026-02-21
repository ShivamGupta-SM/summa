"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

type Direction = "up" | "left" | "right" | "none";

const directionMap: Record<Direction, { x: number; y: number }> = {
	up: { x: 0, y: 24 },
	left: { x: -24, y: 0 },
	right: { x: 24, y: 0 },
	none: { x: 0, y: 0 },
};

interface AnimateInProps {
	children: ReactNode;
	delay?: number;
	direction?: Direction;
	duration?: number;
	className?: string;
	once?: boolean;
}

export function AnimateIn({
	children,
	delay = 0,
	direction = "up",
	duration = 0.55,
	className,
	once = true,
}: AnimateInProps) {
	const { x, y } = directionMap[direction];
	return (
		<motion.div
			initial={{ opacity: 0, x, y }}
			whileInView={{ opacity: 1, x: 0, y: 0 }}
			viewport={{ once, margin: "-30px" }}
			transition={{
				duration,
				delay,
				ease: [0.16, 1, 0.3, 1],
			}}
			className={className}
			style={{ willChange: "opacity, transform" }}
		>
			{children}
		</motion.div>
	);
}
