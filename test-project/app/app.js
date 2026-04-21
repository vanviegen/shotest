const countValue = document.getElementById('count-value');
const incrementBtn = document.getElementById('increment-btn');
const nameInput = document.getElementById('name-input');
const colorSelect = document.getElementById('color-select');
const newsCheckbox = document.getElementById('news-checkbox');
const submitBtn = document.getElementById('submit-btn');
const formStatus = document.getElementById('form-status');
const hoverBtn = document.getElementById('hover-btn');
const hoverState = document.getElementById('hover-state');
const doubleBtn = document.getElementById('double-btn');
const doubleState = document.getElementById('double-state');
const swipeZone = document.getElementById('swipe-zone');
const swipeState = document.getElementById('swipe-state');
const roleToggle = document.getElementById('role-toggle');
const roleState = document.getElementById('role-state');

let count = 0;
incrementBtn.addEventListener('click', () => {
  count += 1;
  countValue.textContent = String(count);
});

submitBtn.addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Anonymous';
  const color = colorSelect.value;
  const news = newsCheckbox.checked ? 'news:on' : 'news:off';
  formStatus.textContent = `${name}|${color}|${news}`;
});

hoverBtn.addEventListener('mouseenter', () => {
  hoverState.textContent = 'hovered';
});
hoverBtn.addEventListener('mouseleave', () => {
  hoverState.textContent = 'not hovered';
});

doubleBtn.addEventListener('dblclick', () => {
  doubleState.textContent = 'doubled';
});

let down = null;
swipeZone.addEventListener('mousedown', (event) => {
  down = { x: event.clientX, y: event.clientY };
});
window.addEventListener('mousemove', (event) => {
  if (!down) return;
  const dx = event.clientX - down.x;
  const dy = event.clientY - down.y;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 35) {
    swipeState.textContent = dx > 0 ? 'right' : 'left';
  } else if (Math.abs(dy) > 35) {
    swipeState.textContent = dy > 0 ? 'down' : 'up';
  }
});
window.addEventListener('mouseup', (event) => {
  if (!down) return;
  const dx = event.clientX - down.x;
  const dy = event.clientY - down.y;
  down = null;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 35) {
    swipeState.textContent = dx > 0 ? 'right' : 'left';
  } else if (Math.abs(dy) > 35) {
    swipeState.textContent = dy > 0 ? 'down' : 'up';
  }
});

roleToggle.addEventListener('click', () => {
  roleState.textContent = roleState.textContent === 'off' ? 'on' : 'off';
});
