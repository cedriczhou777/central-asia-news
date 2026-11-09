/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.REVIEWED_RUNTIME_ONLY === '1' ? { output: 'standalone' } : {}),
  allowedDevOrigins: ['*.dev.coze.site', '*.sh.run.tcloudbase.com', 'localhost'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
