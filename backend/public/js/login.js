import { login, register, refresh, getCurrentUser, homeFor } from './api.js';
import { attempt } from './ui.js';

// Already logged in (valid refresh cookie)? Go straight to the right page.
if (await refresh()) window.location.href = homeFor(getCurrentUser());

document.getElementById('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await attempt(async () => {
    const user = await login(form.get('email'), form.get('password'));
    window.location.href = homeFor(user);
  });
});

document.getElementById('register').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await attempt(async () => {
    await register(form.get('name'), form.get('email'), form.get('password'));
    const user = await login(form.get('email'), form.get('password'));
    window.location.href = homeFor(user);
  });
});
