import { useEffect, useMemo } from 'react';
import { AccountService } from '@/services/AccountService';

// The service is held in useMemo: React's types are not indexed, so its type comes from the factory.
const UserPage = () => {
  const service = useMemo(() => AccountService.getInstance(), []);
  useEffect(() => { void service.profile(1); }, [service]);
  return <div>User</div>;
};
export default UserPage;
