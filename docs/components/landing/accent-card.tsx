"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface AccentCardProps {
	children: ReactNode;
	className?: string;
	accentColor?: string;
}

export function AccentCard({
	children,
	className,
	accentColor = "bg-brand",
}: AccentCardProps) {
	return (
		<motion.div
			className={cn(
				"relative bg-background overflow-hidden group transition-colors",
				"hover:bg-accent/50",
				className,
			)}
			whileHover={{ y: -2 }}
			transition={{ duration: 0.18, ease: "easeOut" }}
		>
			<div
				className={cn(
					"absolute top-0 left-0 h-[3px] w-0 group-hover:w-full transition-all duration-300 ease-out",
					accentColor,
				)}
			/>
			{children}
		</motion.div>
	);
}
