import { getUrlFromEnv } from '@/data/api';
import { api, apiFetch, getJson, postJson, reportsApi } from './client';

export const loadUser = (id: number) => api.get(`/users/${id}`);
export const signInJson = (email: string) => postJson(`${getUrlFromEnv()}auth/login`, { email });
export const saveProfile = (id: number) => apiFetch(`profiles/${id}`, { method: 'PUT' });
export const readProfile = (id: number) => getJson(`profiles/${id}`);
export const relay = (path: string) => postJson(path, {});
export const quarterlyReports = () => reportsApi.get('/reports');
export const choose = (method: string) => apiFetch('profiles/1', { method });
