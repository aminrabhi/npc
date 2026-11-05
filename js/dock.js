// The debug dock.
//
// The simulation console and the conversation logs used to be extra buttons inside the
// tile editor's panel, which meant closing the editor closed them too, and the NPC
// studio was no help. They live here instead: a small fixed toolbar that is always on
// screen and belongs to neither editor.

const DOCK_ID = 'debug-dock';

export function ensureDock() {
  let dock = document.getElementById(DOCK_ID);
  if (!dock) {
    dock = document.createElement('div');
    dock.id = DOCK_ID;
    dock.innerHTML = '<div class="dock-buttons" id="dock-buttons"></div><div class="dock-panels" id="dock-panels"></div>';
    document.body.appendChild(dock);
  }
  return {
    root: dock,
    buttons: dock.querySelector('#dock-buttons'),
    panels: dock.querySelector('#dock-panels'),
  };
}

// One panel at a time: opening the logs should not stack under the console and swallow
// the map. The button of the panel that was closed loses its active state here.
export function focusPanel(section) {
  if (!section || !section.parentElement) return;
  for (const child of section.parentElement.children) {
    if (child !== section) child.hidden = true;
  }
  for (const button of document.querySelectorAll('#dock-buttons [data-panel]')) {
    button.classList.toggle('is-on', button.dataset.panel === section.id && !section.hidden);
  }
}
