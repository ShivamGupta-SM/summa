"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { NavLink } from "./nav-link";
import { NavbarMobile, NavbarMobileBtn } from "./nav-mobile";

export const navMenu = [
	{
		name: "home",
		path: "/",
	},
	{
		name: "docs",
		path: "/docs",
	},
];

export const Navbar = () => {
	const [hidden, setHidden] = useState(false);
	const lastScrollY = useRef(0);

	useEffect(() => {
		const onScroll = () => {
			const y = window.scrollY;
			// Hide when scrolling down past 80px, show when scrolling up
			if (y > lastScrollY.current && y > 80) {
				setHidden(true);
			} else {
				setHidden(false);
			}
			lastScrollY.current = y;
		};

		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<div
			className={cn(
				"flex flex-col sticky top-0 z-50 transition-transform duration-300",
				hidden && "-translate-y-full",
			)}
		>
			<nav className="relative bg-background border-b border-dashed border-border">
				{/* Vertical lines through the navbar — dashed + brand overlay to match layout lines */}
				<div className="pointer-events-none absolute inset-y-0 left-6 lg:left-12 xl:left-16 w-px hidden lg:block border-l border-dashed border-border" />
				<div className="pointer-events-none absolute inset-y-0 right-6 lg:right-12 xl:right-16 w-px hidden lg:block border-r border-dashed border-border" />
				<div className="pointer-events-none absolute inset-y-0 left-6 lg:left-12 xl:left-16 w-px hidden lg:block bg-brand/25" />
				<div className="pointer-events-none absolute inset-y-0 right-6 lg:right-12 xl:right-16 w-px hidden lg:block bg-brand/25" />
				{/* Brand tint on navbar bottom border */}
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-brand/25 hidden lg:block" />
				{/* Intersection markers at navbar bottom border */}
				<div className="pointer-events-none absolute -bottom-2 left-6 lg:left-12 xl:left-16 -translate-x-1/2 hidden lg:block z-60">
					<Plus className="size-4 text-border" strokeWidth={1} />
				</div>
				<div className="pointer-events-none absolute -bottom-2 right-6 lg:right-12 xl:right-16 translate-x-1/2 hidden lg:block z-60">
					<Plus className="size-4 text-border" strokeWidth={1} />
				</div>
				<div className="max-w-400 mx-auto w-full flex items-center justify-between px-4 sm:px-6 lg:px-12">
					<Link
						href="/"
						className="flex items-center gap-2.5 py-7 text-foreground shrink-0 transition-colors"
					>
						<Logo className="size-5" />
						<span className="text-sm font-medium tracking-widest uppercase select-none">Summa</span>
					</Link>
					<div className="flex items-center gap-1">
						<ul className="navbar:flex items-center hidden">
							{navMenu.map((menu) => (
								<NavLink key={menu.name} href={menu.path}>
									{menu.name}
								</NavLink>
							))}
							<NavLink
								href="https://github.com/summa-ledger/summa"
								external
								aria-label="View Summa repository on GitHub"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="1.2em"
									height="1.2em"
									viewBox="0 0 496 512"
									aria-hidden="true"
								>
									<path
										fill="currentColor"
										d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6c-3.3.3-5.6-1.3-5.6-3.6c0-2 2.3-3.6 5.2-3.6c3-.3 5.6 1.3 5.6 3.6m-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9c2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3m44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9c.3 2 2.9 3.3 5.9 2.6c2.9-.7 4.9-2.6 4.6-4.6c-.3-1.9-3-3.2-5.9-2.9M244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2c12.8 2.3 17.3-5.6 17.3-12.1c0-6.2-.3-40.4-.3-61.4c0 0-70 15-84.7-29.8c0 0-11.4-29.1-27.8-36.6c0 0-22.9-15.7 1.6-15.4c0 0 24.9 2 38.6 25.8c21.9 38.6 58.6 27.5 72.9 20.9c2.3-16 8.8-27.1 16-33.7c-55.9-6.2-112.3-14.3-112.3-110.5c0-27.5 7.6-41.3 23.6-58.9c-2.6-6.5-11.1-33.3 2.6-67.9c20.9-6.5 69 27 69 27c20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27c13.7 34.7 5.2 61.4 2.6 67.9c16 17.7 25.8 31.5 25.8 58.9c0 96.5-58.9 104.2-114.8 110.5c9.2 7.9 17 22.9 17 46.4c0 33.7-.3 75.4-.3 83.6c0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252C496 113.3 383.5 8 244.8 8M97.2 352.9c-1.3 1-1 3.3.7 5.2c1.6 1.6 3.9 2.3 5.2 1c1.3-1 1-3.3-.7-5.2c-1.6-1.6-3.9-2.3-5.2-1m-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9c1.6 1 3.6.7 4.3-.7c.7-1.3-.3-2.9-2.3-3.9c-2-.6-3.6-.3-4.3.7m32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2c2.3 2.3 5.2 2.6 6.5 1c1.3-1.3.7-4.3-1.3-6.2c-2.2-2.3-5.2-2.6-6.5-1m-11.4-14.7c-1.6 1-1.6 3.6 0 5.9c1.6 2.3 4.3 3.3 5.6 2.3c1.6-1.3 1.6-3.9 0-6.2c-1.4-2.3-4-3.3-5.6-2"
									/>
								</svg>
							</NavLink>
						</ul>
						<ThemeToggle />
						<NavbarMobileBtn />
					</div>
				</div>
			</nav>
			<NavbarMobile />
		</div>
	);
};
