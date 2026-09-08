'use client';

import { useAuth } from '../../lib/auth';
import { Empty, Spinner } from '../../components/ui';

/**
 * Role gate for the operator console.
 *
 * This is a client-side gate for UX only - the real enforcement is server-side
 * (every /v1/admin route checks role === 'platform_admin' and answers 403).
 * Never rely on hiding a link as a security control.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();

  if (loading) return <Spinner />;
  if (!me) return null; // AuthProvider is already redirecting to /login

  if (me.user.role !== 'platform_admin') {
    return (
      <Empty
        title="Not available"
        hint="The operator console is for Munim staff. Your account does not have access."
      />
    );
  }
  return <>{children}</>;
}
