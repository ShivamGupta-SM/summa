"use client";

import { cn } from "@/lib/utils";

interface RippleProps {
	className?: string;
}

export function Ripple({ className }: RippleProps) {
	return (
		<div
			className={cn(
				"absolute inset-0 overflow-hidden [mask-image:linear-gradient(to_bottom,white,transparent)]",
				className,
			)}
		>
			{Array.from({ length: 10 }).map((_, i) => {
				const size = 150 + i * 80;
				const opacity = 0.2 - i * 0.03;
				const delay = i * 0.06;

				return (
					<div
						key={i}
						className={cn(
							"animate-ripple rounded-full bg-brand/10 border border-brand/20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
							i === 9 && "border-dashed",
						)}
						style={{
							width: size,
							height: size,
							opacity,
							animationDelay: `${delay}s`,
						}}
					/>
				);
			})}
		</div>
	);
}
