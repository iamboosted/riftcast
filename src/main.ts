import './style.css';
import { Game } from './game/game';
import { installMobileGuards } from './core/mobile';

installMobileGuards();
const game = new Game();
game
  .start()
  .then(() => document.getElementById('boot')?.remove())
  .catch((e) => {
    console.error(e);
    const el = document.getElementById('boot');
    if (el) el.innerHTML = `<b>Riftcast couldn't start</b><small>${String(e?.message ?? e)}</small><small>Try a recent Safari, Chrome or Firefox.</small>`;
  });
