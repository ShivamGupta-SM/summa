import { cn } from "@/lib/utils";

type SpotlightProps = {
	className?: string;
};

export const Spotlight = ({ className }: SpotlightProps) => {
	return (
		<div
			className={cn(
				"pointer-events-none absolute -top-40 left-0 z-[1] h-[60%] w-[80%] opacity-0 animate-spotlight hidden sm:block",
				className,
			)}
			style={{
				background:
					"radial-gradient(ellipse 80% 50% at 20% 40%, color-mix(in oklch, var(--brand) 8%, transparent), transparent 70%)",
			}}
		/>
	);
};
