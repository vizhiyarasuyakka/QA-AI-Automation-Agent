/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: '100mb' } },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'mammoth', 'exceljs', '@napi-rs/canvas', 'typescript', 'jszip', 'sharp', 'playwright-core'],
};
export default nextConfig;
