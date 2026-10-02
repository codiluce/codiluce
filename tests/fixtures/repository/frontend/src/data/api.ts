export function getUrlFromEnv() {
  const productionUrl = 'https://api.fixture.test/';
  const fromEnv = process.env.NEXT_PUBLIC_API_URL;
  const url = new URL(fromEnv || productionUrl);
  if (typeof window !== 'undefined' && url.protocol !== 'https:') return new URL(productionUrl);
  return url;
}
