import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const config: NextConfig = {
	reactStrictMode: true,
	async redirects() {
		return [
			{
				source: "/docs",
				destination: "/docs/index",
				permanent: true,
			},
		];
	},
};

export default withMDX(config);
