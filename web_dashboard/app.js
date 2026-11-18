const grid = document.querySelector('#dashboard-grid');
const announcement = document.querySelector('#layout-announcement');
const panels = [...grid.querySelectorAll('.panel')];
const storageKey = 'manta-ray-panel-order';

function updateLayout(message) {
  const ordered = [...grid.children];
  ordered.forEach((panel, index) => {
    panel.querySelector('[data-direction="-1"]').disabled = index === 0;
    panel.querySelector('[data-direction="1"]').disabled = index === ordered.length - 1;
  });
  try {
    localStorage.setItem(storageKey, JSON.stringify(ordered.map((panel) => panel.dataset.panel)));
  } catch {
    // The dashboard remains usable when browser storage is unavailable.
  }
  if (message) announcement.textContent = message;
}

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved) && saved.length === panels.length && new Set(saved).size === panels.length && saved.every((id) => panels.some((panel) => panel.dataset.panel === id))) {
    saved.forEach((id) => grid.append(panels.find((panel) => panel.dataset.panel === id)));
  }
} catch {
  // Ignore unavailable or invalid saved layouts.
}
updateLayout();

grid.addEventListener('click', (event) => {
  const button = event.target.closest('.move-panel');
  if (!button) return;
  const panel = button.closest('.panel');
  const direction = Number(button.dataset.direction);
  const neighbor = direction < 0 ? panel.previousElementSibling : panel.nextElementSibling;
  if (!neighbor) return;
  if (direction < 0) grid.insertBefore(panel, neighbor);
  else grid.insertBefore(neighbor, panel);
  updateLayout(`${panel.querySelector('h2').textContent} moved to position ${[...grid.children].indexOf(panel) + 1}.`);
  if (button.disabled) panel.querySelector(`[data-direction="${-direction}"]`).focus();
});

let draggedPanel = null;
grid.addEventListener('dragstart', (event) => {
  if (event.target.closest('button')) {
    event.preventDefault();
    return;
  }
  const header = event.target.closest('.panel-header');
  if (!header) return;
  draggedPanel = header.closest('.panel');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedPanel.dataset.panel);
  draggedPanel.classList.add('dragging');
});
grid.addEventListener('dragover', (event) => {
  if (!draggedPanel) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const target = event.target.closest('.panel');
  panels.forEach((panel) => panel.classList.toggle('drop-target', panel === target && panel !== draggedPanel));
});
grid.addEventListener('drop', (event) => {
  if (!draggedPanel) return;
  event.preventDefault();
  const target = event.target.closest('.panel');
  if (target && target !== draggedPanel) {
    const ordered = [...grid.children];
    if (ordered.indexOf(draggedPanel) < ordered.indexOf(target)) grid.insertBefore(draggedPanel, target.nextSibling);
    else grid.insertBefore(draggedPanel, target);
    updateLayout(`${draggedPanel.querySelector('h2').textContent} moved to position ${[...grid.children].indexOf(draggedPanel) + 1}.`);
  }
});
grid.addEventListener('dragend', () => {
  panels.forEach((panel) => panel.classList.remove('dragging', 'drop-target'));
  draggedPanel = null;
});

const fileInput = document.querySelector('#video-file');
const video = document.querySelector('#survey-video');
let videoUrl;
document.querySelectorAll('.file-trigger').forEach((button) => {
  button.addEventListener('click', () => fileInput.click());
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  video.hidden = false;
  document.querySelector('#video-placeholder').hidden = true;
  document.querySelector('#video-source').textContent = file.name;
});

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]);
    tabs[next].focus();
  });
});

document.querySelector('#terminal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#command-input');
  const command = input.value.trim();
  if (!command) return;
  const output = document.querySelector('#terminal-output');
  const line = document.createElement('p');
  line.textContent = `> ${command}`;
  const reply = document.createElement('p');
  reply.className = 'terminal-muted';
  reply.textContent = 'Preview only: no command was sent or executed.';
  output.replaceChildren(line, reply);
  input.value = '';
});
