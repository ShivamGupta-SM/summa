import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

export const Logo = (props: SVGProps<SVGSVGElement>) => {
	return (
		<svg
			width="60"
			height="60"
			viewBox="0 0 60 60"
			fill="none"
			className={cn("w-5 h-5", props.className)}
			xmlns="http://www.w3.org/2000/svg"
			aria-label="Summa logo"
			role="img"
			{...props}
		>
			<path
				d="M12 8H48V16H24L34 30L24 44H48V52H12V44L26 30L12 16V8Z"
				className="fill-black dark:fill-white"
			/>
		</svg>
	);
};
