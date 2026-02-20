"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const themeMap = {
	light: "light",
	dark: "dark",
} as const;

function renderThemeIcon(theme: string | undefined) {
	switch (theme) {
		case themeMap.light:
			return <LightThemeIcon />;
		case themeMap.dark:
			return <DarkThemeIcon />;
		default:
			return null;
	}
}

export function ThemeToggle(props: ComponentProps<typeof Button>) {
	const { setTheme, resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	return (
		<Button
			variant="ghost"
			size="icon"
			aria-label="Toggle theme"
			onClick={() => {
				setTheme(
					resolvedTheme === themeMap.dark ? themeMap.light : themeMap.dark,
				);
			}}
			{...props}
			className={cn(
				"flex shrink-0 size-10 navbar:size-14 navbar:border-l text-muted-foreground hover:text-foreground max-navbar:hover:bg-transparent rounded-none",
				props.className,
			)}
		>
			<AnimatePresence mode="wait">
				{mounted && renderThemeIcon(resolvedTheme)}
			</AnimatePresence>
		</Button>
	);
}

const LightThemeIcon = () => {
	return (
		<motion.div
			key="light"
			initial={{ opacity: 0, rotate: -90 }}
			animate={{ opacity: 1, rotate: 0 }}
			exit={{ opacity: 0, rotate: 90 }}
			transition={{ duration: 0.2 }}
		>
			<Sun className="size-4" />
		</motion.div>
	);
};

const DarkThemeIcon = () => {
	return (
		<motion.div
			key="dark"
			initial={{ opacity: 0, rotate: 90 }}
			animate={{ opacity: 1, rotate: 0 }}
			exit={{ opacity: 0, rotate: -90 }}
			transition={{ duration: 0.2 }}
		>
			<Moon className="size-4" />
		</motion.div>
	);
};
