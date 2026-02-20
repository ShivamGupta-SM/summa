import { cn } from "@/lib/utils";

type SpotlightProps = {
	className?: string;
};

export const Spotlight = ({ className }: SpotlightProps) => {
	return (
		<div
			className={cn(
				"pointer-events-none absolute -top-40 left-0 z-[1] h-[60%] w-[80%] opacity-0 animate-spotlight",
				className,
			)}
			style={{
				background:
					"radial-gradient(ellipse 80% 50% at 20% 40%, oklch(0.65 0.2 160 / 0.08), transparent 70%)",
			}}
		/>
	);
};
