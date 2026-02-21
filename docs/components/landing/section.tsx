import type React from "react";

const Section = ({
	className,
	id,
	customPaddings,
	children,
}: {
	className: string;
	id: string;
	customPaddings?: boolean;
	children: React.ReactNode;
}) => {
	return (
		<div
			id={id}
			className={`
      relative
      ${customPaddings || `py-10 lg:py-16`}
      ${className || " "}`}
		>
			{children}
			{/* Brand tint on bottom border — matches vertical brand lines */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-brand/25 hidden lg:block" />
		</div>
	);
};

export default Section;
