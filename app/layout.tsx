import type {Metadata} from 'next';
import brand from '../brand.json';
import './globals.css';
export const metadata:Metadata={title:{default:`${brand.name} · More intelligence. Less spend.`,template:`%s · ${brand.name}`},description:brand.description};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body style={{'--bg':brand.colors.background,'--ink':brand.colors.ink,'--accent':brand.colors.accent} as React.CSSProperties}>{children}</body></html>}
