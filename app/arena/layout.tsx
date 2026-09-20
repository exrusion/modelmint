import type {Metadata} from 'next';

export const metadata:Metadata={
  title:'Router Arena — Test your API key',
  description:'A live mini-game powered by your Routers API key and model of choice.'
};

export default function ArenaLayout({children}:{children:React.ReactNode}){return children;}
