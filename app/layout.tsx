import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'StockSense — Inventory operations',
  description: 'A clear, reliable view of stock across every warehouse.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><ClerkProvider>{children}</ClerkProvider></body></html>;
}
