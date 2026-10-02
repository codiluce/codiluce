export async function loadProfile(id: number) {
  const response = await fetch(`/profiles/${id}`);
  return response.json();
}
