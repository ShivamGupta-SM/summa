"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";

interface NavbarMobileContextProps {
	isOpen: boolean;
	toggleNavbar: () => void;
}

const NavbarContext = createContext<NavbarMobileContextProps | undefined>(
	undefined,
);

export const NavbarProvider = ({ children }: { children: React.ReactNode }) => {
	const [isOpen, setIsOpen] = useState(false);

	const toggleNavbar = () => {
		setIsOpen((prev) => !prev);
	};

	return (
		<NavbarContext.Provider value={{ isOpen, toggleNavbar }}>
			{children}
		</NavbarContext.Provider>
	);
};

export const useNavbarMobile = (): NavbarMobileContextProps => {
	const context = useContext(NavbarContext);
	if (!context) {
		throw new Error(
			"useNavbarMobile must be used within a NavbarProvider",
		);
	}
	return context;
};

export const NavbarMobileBtn: React.FC = () => {
	const { toggleNavbar } = useNavbarMobile();

	return (
		<button
			type="button"
			aria-label="Toggle navigation menu"
			className="flex items-center justify-center size-9 navbar:hidden text-muted-foreground"
			onClick={() => {
				toggleNavbar();
			}}
		>
			<Menu className="size-5" />
		</button>
	);
};

const navMenu = [
	{ name: "Home", path: "/" },
	{ name: "Docs", path: "/docs" },
	{ name: "GitHub", path: "https://github.com/summa-ledger/summa", external: true },
];

export const NavbarMobile = () => {
	const { isOpen, toggleNavbar } = useNavbarMobile();

	return (
		<div
			className={cn(
				"fixed top-19 inset-x-0 transform-gpu z-100 bg-background/95 backdrop-blur-lg grid grid-rows-[0fr] duration-300 transition-all navbar:hidden",
				isOpen &&
					"shadow-lg border-b border-border grid-rows-[1fr]",
			)}
		>
			<div
				className={cn(
					"px-6 min-h-0 overflow-y-auto max-h-[80vh] divide-y divide-border transition-all duration-300",
					isOpen ? "py-4" : "invisible",
				)}
			>
				{navMenu.map((menu) => (
					<Link
						key={menu.name}
						href={menu.path}
						className="group flex items-center gap-2.5 first:pt-0 last:pb-0 text-base tracking-wider py-3.5 text-muted-foreground hover:text-foreground transition-colors"
						onClick={toggleNavbar}
						{...(menu.external
							? { target: "_blank", rel: "noopener noreferrer" }
							: {})}
					>
						{menu.name}
					</Link>
				))}
			</div>
		</div>
	);
};
