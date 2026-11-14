/** @type {import('next').NextConfig} */
const nextConfig = {
  // A second build folder lets a production build run beside a dev server (NEXT_DIST_DIR=.next-prod).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { serverActions: { bodySizeLimit: '100mb' } },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'mammoth', 'exceljs', '@napi-rs/canvas', 'typescript', 'jszip', 'sharp', 'playwright-core'],
};
export default nextConfig;
