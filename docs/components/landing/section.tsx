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
		</div>
	);
};

export default Section;
