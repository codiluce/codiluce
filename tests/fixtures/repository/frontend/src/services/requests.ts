import axios from 'axios';
export const ping = () => fetch('/api/ping');
export const getUser = () => axios.get('https://api.fixture.test/users/123');
export const dynamicUrl = (id: string) => fetch(`/users/${id}`);
export const dynamicOptions = (options: RequestInit) => fetch('/api/ping', options);
export const constrained = () => fetch('https://api.fixture.test/constrained/123');
export const ambiguous = () => fetch('https://api.fixture.test/duplicate');
export const external = () => fetch('https://unrelated.fixture.test/users/123');
export const relativeBackend = () => fetch('/auth/login', { method: 'POST' });
export function localFetch(fetch: (url: string) => unknown) { return fetch('/api/ping'); }
export const spreadOptions = (options: RequestInit) => fetch('/api/ping', { method: 'GET', ...options });
export const useAuth = () => ({ ready: true });
export const shadowedAxios = (axios: { get: (url: string) => unknown }) => axios.get('https://api.fixture.test/users/123');
export function destructuredFetch({ fetch }: { fetch: (url: string) => unknown }) { return fetch('/api/ping'); }
