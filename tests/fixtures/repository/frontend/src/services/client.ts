import axios from 'axios';
import { getUrlFromEnv } from '@/data/api';

export const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL });
export const reportsApi = axios.create({ baseURL: process.env.REPORTS_URL });

export async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return response.json();
}
export const apiFetch = (path: string, init?: RequestInit) => fetch(`${getUrlFromEnv()}${path}`, { ...init, headers: { Accept: 'application/json' } });
export const getJson = (path: string) => apiFetch(path);
