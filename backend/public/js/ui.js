// Tiny DOM helpers. Text is always set with textContent, never innerHTML, so names or
// locations typed by users can never inject HTML or scripts into the page.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function replace(container, ...children) {
  container.replaceChildren(...children.flat().filter(Boolean));
}

// A message bar at the top of the page.
export function notify(message, kind = 'ok') {
  const bar = document.getElementById('notice');
  if (!bar) return;
  bar.textContent = message;
  bar.className = `notice ${kind}`;
  bar.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (bar.hidden = true), 6000);
}

// Runs an action, shows its error message if it fails, and returns whether it worked.
export async function attempt(action, successMessage) {
  try {
    await action();
    if (successMessage) notify(successMessage, 'ok');
    return true;
  } catch (err) {
    notify(err.message || 'Something went wrong', 'error');
    return false;
  }
}

export function badge(text, kind = '') {
  return el('span', { class: `badge ${kind}` }, text);
}

export function emptyRow(text) {
  return el('p', { class: 'empty' }, text);
}
