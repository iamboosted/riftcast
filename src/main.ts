import './style.css';
import { Game } from './game/game';
import { installMobileGuards } from './core/mobile';

installMobileGuards();
const game = new Game();
game.start().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot');
  if (el) el.innerHTML = `<b>Riftcast couldn't start</b><br>${String(e?.message ?? e)}<br><small>Try a recent Safari, Chrome or Firefox.</small>`;
}).then(() => {
  document.getElementById('boot')?.remove();
});
