import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./pwa-controls";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.NODE_ENV === "production"
        ? "https://tegar-edge.vercel.app"
        : "http://localhost:3000"),
  ),
  title: "Tegar Pi Control",
  description:
    "A remote IoT console for Raspberry Pi LED, Xiaomi room climate, and private Pi-side edge vision.",
  applicationName: "Tegar Pi Control",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Tegar Pi",
  },
  icons: {
    apple: "/apple-touch-icon.png",
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  openGraph: {
    title: "Tegar Pi Control",
    description: "Private edge IoT control, climate history, and Pi-side vision.",
    images: [{ url: "/og.png", width: 1731, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tegar Pi Control",
    description: "Private edge IoT control, climate history, and Pi-side vision.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#07100c",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
