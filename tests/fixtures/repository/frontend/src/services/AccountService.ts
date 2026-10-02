import { getUrlFromEnv } from '@/data/api';

export class AccountService {
  private static instance: AccountService;
  private API_BASE_URL: string;
  private constructor() {
    this.API_BASE_URL = getUrlFromEnv().toString();
  }
  static getInstance(): AccountService {
    if (!AccountService.instance) AccountService.instance = new AccountService();
    return AccountService.instance;
  }
  async signIn(email: string) {
    const response = await fetch(`${this.API_BASE_URL}auth/login`, { method: 'POST', body: email });
    if (!response.ok) throw new Error('Sign-in failed');
    localStorage.setItem('session', email);
    return response.json();
  }
  async profile(id: number) {
    return fetch(`${this.API_BASE_URL}profiles/${id}`);
  }
  async missing() {
    return fetch(`${this.API_BASE_URL}nowhere/at/all`);
  }
  async elsewhere() {
    return fetch(`${process.env.OTHER_SERVICE_URL}reports`);
  }
}
