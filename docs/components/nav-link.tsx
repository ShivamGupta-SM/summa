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
		<li className={cn("relative group", className)}>
			<Link
				href={href}
				className={cn(
					"flex items-center h-14 px-4 text-sm transition-colors duration-200",
					"group-hover:text-foreground",
					isActive ? "text-foreground" : "text-muted-foreground",
				)}
				target={external ? "_blank" : undefined}
				rel={external ? "noopener noreferrer" : undefined}
				aria-label={ariaLabel}
			>
				{children}
			</Link>
			<div
				className={cn(
					"absolute bottom-0 left-0 h-px bg-foreground opacity-0 transition-all duration-300",
					"group-hover:opacity-100 group-hover:w-full",
					isActive ? "opacity-100 w-full" : "w-0",
				)}
			/>
		</li>
	);
};
