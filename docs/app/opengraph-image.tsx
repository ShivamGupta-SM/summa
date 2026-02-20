import { ImageResponse } from "next/og";

export const alt = "Summa — Event-sourced double-entry financial ledger";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
	return new ImageResponse(
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: "100%",
				height: "100%",
				backgroundColor: "#0a0c14",
				padding: "60px 80px",
				fontFamily: "Inter, system-ui, sans-serif",
				position: "relative",
				overflow: "hidden",
			}}
		>
			{/* Subtle grid */}
			<div
				style={{
					display: "flex",
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					bottom: 0,
					backgroundImage:
						"linear-gradient(rgba(52,211,153,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.035) 1px, transparent 1px)",
					backgroundSize: "48px 48px",
				}}
			/>

			{/* Glow */}
			<div
				style={{
					display: "flex",
					position: "absolute",
					top: -180,
					right: -60,
					width: 520,
					height: 520,
					borderRadius: "50%",
					background:
						"radial-gradient(circle, rgba(52,211,153,0.1) 0%, transparent 65%)",
				}}
			/>

			{/* Bottom-left glow */}
			<div
				style={{
					display: "flex",
					position: "absolute",
					bottom: -200,
					left: -100,
					width: 400,
					height: 400,
					borderRadius: "50%",
					background:
						"radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 65%)",
				}}
			/>

			{/* Top row: logo + label */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 16,
				}}
			>
				{/* Logo mark */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: 44,
						height: 44,
						borderRadius: 10,
						backgroundColor: "#141925",
						border: "1px solid rgba(52,211,153,0.15)",
					}}
				>
					<svg width="28" height="28" viewBox="0 0 60 60" fill="none">
						<path
							d="M12 8H48V16H24L34 30L24 44H48V52H12V44L26 30L12 16V8Z"
							fill="#34d399"
						/>
					</svg>
				</div>
				<div
					style={{
						display: "flex",
						fontSize: 18,
						fontWeight: 500,
						color: "rgba(255,255,255,0.4)",
						letterSpacing: "0.08em",
						textTransform: "uppercase" as const,
					}}
				>
					Financial Infrastructure
				</div>
			</div>

			{/* Center content */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					marginTop: "auto",
					marginBottom: "auto",
					gap: 20,
				}}
			>
				<div
					style={{
						display: "flex",
						fontSize: 76,
						fontWeight: 700,
						color: "#ffffff",
						lineHeight: 1,
						letterSpacing: "-0.03em",
					}}
				>
					Summa
				</div>
				<div
					style={{
						display: "flex",
						fontSize: 30,
						fontWeight: 400,
						color: "rgba(255,255,255,0.6)",
						lineHeight: 1.4,
					}}
				>
					The ledger your money deserves.
				</div>
			</div>

			{/* Bottom tags */}
			<div style={{ display: "flex", gap: 10 }}>
				{["Event-sourced", "Double-entry", "Type-safe"].map((tag) => (
					<div
						key={tag}
						style={{
							display: "flex",
							padding: "8px 22px",
							borderRadius: 6,
							border: "1px solid rgba(52,211,153,0.2)",
							backgroundColor: "rgba(52,211,153,0.06)",
							color: "#34d399",
							fontSize: 15,
							fontWeight: 500,
							letterSpacing: "0.01em",
						}}
					>
						{tag}
					</div>
				))}
			</div>
		</div>,
		{ ...size },
	);
}
