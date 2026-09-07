/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Demo app runs on a single Lightsail node; keep it simple.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
