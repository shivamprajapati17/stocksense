/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  distDir: process.env.STOCKSENSE_DEV_CACHE === 'true' ? '.next-demo' : process.env.STOCKSENSE_DEV_CACHE || '.next',
};

export default nextConfig;
