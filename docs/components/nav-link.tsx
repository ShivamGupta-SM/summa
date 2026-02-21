"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { cn } from "@/lib/utils";

type Props = {
	href: string;
	children: React.ReactNode;
	className?: string;
	external?: boolean;
	"aria-label"?: string;
};

export const NavLink = ({
	href,
	children,
	className,
	external,
	"aria-label": ariaLabel,
}: Props) => {
	const segment = useSelectedLayoutSegment();
	const isActive =
		segment === href.slice(1) || (segment === null && href === "/");

	return (
		<li className={cn("relative", className)}>
			<Link
				href={href}
				className={cn(
					"flex items-center py-7 px-4 text-sm tracking-wider transition-colors duration-200",
					"hover:text-foreground",
					isActive ? "text-foreground" : "text-muted-foreground",
				)}
				target={external ? "_blank" : undefined}
				rel={external ? "noopener noreferrer" : undefined}
				aria-label={ariaLabel}
			>
				{children}
			</Link>
		</li>
	);
};
