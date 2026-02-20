import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import {
	ArchiveBoxXMarkIcon,
	ArrowsRightLeftIcon,
	BeakerIcon,
	BoltIcon,
	BookOpenIcon,
	CalendarDaysIcon,
	CameraIcon,
	CircleStackIcon,
	ClipboardDocumentListIcon,
	ClockIcon,
	Cog6ToothIcon,
	CommandLineIcon,
	ExclamationTriangleIcon,
	FireIcon,
	GlobeAltIcon,
	LockClosedIcon,
	PaperAirplaneIcon,
	PuzzlePieceIcon,
	QueueListIcon,
	RocketLaunchIcon,
	ScaleIcon,
	ServerIcon,
	WalletIcon,
	CodeBracketIcon,
	DocumentTextIcon,
	ShieldCheckIcon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/solid";
import type { ComponentType, ReactElement } from "react";
import { createElement } from "react";

// Brand SVG icons for adapters (actual logos, not generic icons)
function DrizzleIcon({ className }: { className?: string }) {
	return createElement(
		"svg",
		{
			viewBox: "0 0 24 24",
			fill: "currentColor",
			className,
			"aria-hidden": true,
		},
		createElement("path", {
			d: "M5.353 11.823a1.036 1.036 0 0 0-.395-1.422 1.063 1.063 0 0 0-1.437.399L.138 16.702a1.035 1.035 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.398l3.383-5.903Zm11.216 0a1.036 1.036 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.399l-3.382 5.902a1.036 1.036 0 0 0 .394 1.422c.506.283 1.15.104 1.438-.398l3.382-5.903Zm7.293-4.525a1.036 1.036 0 0 0-.395-1.422 1.062 1.062 0 0 0-1.437.399l-3.383 5.902a1.036 1.036 0 0 0 .395 1.422 1.063 1.063 0 0 0 1.437-.399l3.383-5.902Zm-11.219 0a1.035 1.035 0 0 0-.394-1.422 1.064 1.064 0 0 0-1.438.398l-3.382 5.903a1.036 1.036 0 0 0 .394 1.422c.506.282 1.15.104 1.438-.399l3.382-5.902Z",
		}),
	);
}

function PrismaIcon({ className }: { className?: string }) {
	return createElement(
		"svg",
		{
			viewBox: "0 0 24 24",
			fill: "currentColor",
			className,
			"aria-hidden": true,
		},
		createElement("path", {
			d: "M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z",
		}),
	);
}

const iconMap: Record<
	string,
	ComponentType<{ className?: string }> | (() => ReactElement)
> = {
	// Top-level
	RocketLaunch: RocketLaunchIcon,
	BookOpen: BookOpenIcon,
	Cog: Cog6ToothIcon,
	Wallet: WalletIcon,
	ArrowsRightLeft: ArrowsRightLeftIcon,
	LockClosed: LockClosedIcon,
	QueueList: QueueListIcon,
	PuzzlePiece: PuzzlePieceIcon,
	GlobeAlt: GlobeAltIcon,
	Server: ServerIcon,
	CommandLine: CommandLineIcon,
	ExclamationTriangle: ExclamationTriangleIcon,
	// Adapters — actual brand logos
	Drizzle: DrizzleIcon,
	Prisma: PrismaIcon,
	Beaker: BeakerIcon,
	CircleStack: CircleStackIcon,
	// Plugins
	ClipboardDocumentList: ClipboardDocumentListIcon,
	Scale: ScaleIcon,
	Camera: CameraIcon,
	Bolt: BoltIcon,
	PaperAirplane: PaperAirplaneIcon,
	Fire: FireIcon,
	CalendarDays: CalendarDaysIcon,
	Clock: ClockIcon,
	WrenchScrewdriver: WrenchScrewdriverIcon,
	ArchiveBoxXMark: ArchiveBoxXMarkIcon,
	// Client SDK
	CodeBracket: CodeBracketIcon,
	// Admin & OpenAPI plugins
	ShieldCheck: ShieldCheckIcon,
	DocumentText: DocumentTextIcon,
};

export const source = loader({
	source: docs.toFumadocsSource(),
	baseUrl: "/docs",
	icon(icon) {
		if (!icon) return;
		const Comp = iconMap[icon];
		if (Comp) return createElement(Comp, { className: "size-4" });
	},
});
