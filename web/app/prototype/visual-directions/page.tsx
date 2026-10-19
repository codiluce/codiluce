// PROTOTYPE (throwaway) — the three prototypes of docs/design/visual-directions.md:
// ?proto=focus|agents|beat and ?variant=A|B|C on one route, switched from the floating bar.
// Run: npm run prototype:visual, then open http://127.0.0.1:4390/prototype/visual-directions
import { notFound } from 'next/navigation';
import { Prototype } from './prototype';
import './prototype.css';

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Prototype />;
}
