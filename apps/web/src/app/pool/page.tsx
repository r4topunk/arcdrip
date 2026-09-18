import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PoolView } from '@/components/pool/pool-view';
import { Skeleton } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Pool',
  description:
    'One ArcDrip pool: rate, balance, runway, the member table ticking every second, deposit, "Pay everyone", and the owner and member panels.',
};

// A static export cannot pre-render unknown pool ids, so this one page reads ?id=N on the client (PRD 6).
export default function PoolPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <PoolView />
    </Suspense>
  );
}
