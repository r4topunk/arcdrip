import type { Metadata } from 'next';
import { DocsPage } from '@/components/docs';
import { loadDocs } from '@/lib/docs';

export const metadata: Metadata = {
  title: 'Docs',
  description:
    'How ArcDrip accrual works, the guarantees it gives members and owners, how to plug a Safe or a DAO as owner, and how it compares to Sablier, 0xSplits and the Arc Studio Revenue Router.',
};

export default function Page() {
  return <DocsPage docs={loadDocs()} />;
}
