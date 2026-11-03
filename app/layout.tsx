import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FairShift AI",
  description:
    "Transparent tips and payouts for hospitality workers, powered by PayPal and AI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
