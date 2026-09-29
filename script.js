const SIZE = 10;
const FLEET = [
  { name: 'Линкор', length: 4, symbol: '▰▰▰▰' },
  { name: 'Крейсер', length: 3, symbol: '▰▰▰' },
  { name: 'Крейсер', length: 3, symbol: '▰▰▰' },
  { name: 'Эсминец', length: 2, symbol: '▰▰' },
  { name: 'Эсминец', length: 2, symbol: '▰▰' },
  { name: 'Эсминец', length: 2, symbol: '▰▰' },
  { name: 'Катер', length: 1, symbol: '▰' },
  { name: 'Катер', length: 1, symbol: '▰' },
  { name: 'Катер', length: 1, symbol: '▰' },
  { name: 'Катер', length: 1, symbol: '▰' },
];

const state = {
  screen: 'home', difficulty: 'easy', selectedLevel: 1, rotation: 'horizontal', selectedShip: 0,
  playerBoard: createEmptyBoard(), enemyBoard: createEmptyBoard(), playerShips: [], enemyShips: [],
  playerShots: new Set(), aiShots: new Set(), aiTargets: [], turn: 'player', shots: 0, hits: 0,
  wins: Number(localStorage.getItem('neonFleetWins') || 0), losses: Number(localStorage.getItem('neonFleetLosses') || 0),
  coins: Number(localStorage.getItem('neonFleetCoins') || 1045), user: null, progress: null,
  onlineMatch: null, onlineFleet: null, onlinePoll: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const indexOf = (row, col) => row * SIZE + col;
const coordsOf = (index) => ({ row: Math.floor(index / SIZE), col: index % SIZE });

async function apiRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `request_${response.status}`);
  return body;
}

function createEmptyBoard() { return Array.from({ length: SIZE * SIZE }, () => null); }
function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible'); clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800); }
function shuffle(array) { return [...array].sort(() => Math.random() - 0.5); }

function showScreen(screen) {
  state.screen = screen;
  $$('.view').forEach((view) => view.classList.toggle('is-active', view.dataset.view === screen));
  $$('.nav-link').forEach((link) => link.classList.toggle('is-active', link.dataset.screen === screen));
  if (screen === 'account') renderAccount();
  if (screen === 'online') renderOnlineMatch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', `#${screen}`);
}

function neighbors(row, col, includeDiagonals = true) {
  const result = [];
  for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
    if (dr === 0 && dc === 0) continue;
    if (!includeDiagonals && Math.abs(dr) + Math.abs(dc) !== 1) continue;
    const nextRow = row + dr, nextCol = col + dc;
    if (nextRow >= 0 && nextRow < SIZE && nextCol >= 0 && nextCol < SIZE) result.push(indexOf(nextRow, nextCol));
  }
  return result;
}

function canPlace(board, row, col, length, rotation) {
  const positions = [];
  for (let step = 0; step < length; step += 1) {
    const nextRow = row + (rotation === 'vertical' ? step : 0), nextCol = col + (rotation === 'horizontal' ? step : 0);
    if (nextRow >= SIZE || nextCol >= SIZE || board[indexOf(nextRow, nextCol)] !== null) return null;
    positions.push(indexOf(nextRow, nextCol));
  }
  const current = new Set(positions);
  for (const position of positions) {
    const { row: currentRow, col: currentCol } = coordsOf(position);
    if (neighbors(currentRow, currentCol).some((near) => board[near] !== null && !current.has(near))) return null;
  }
  return positions;
}

function placeShip(board, ships, row, col, length, rotation, name) {
  const positions = canPlace(board, row, col, length, rotation);
  if (!positions) return false;
  const ship = { id: ships.length, name, length, positions, hits: new Set() };
  positions.forEach((position) => { board[position] = ship.id; });
  ships.push(ship);
  return true;
}

function randomFleet() {
  const board = createEmptyBoard(), ships = [];
  for (const spec of FLEET) {
    let placed = false;
    for (let attempt = 0; attempt < 3000 && !placed; attempt += 1) {
      placed = placeShip(board, ships, Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE), spec.length, Math.random() > .5 ? 'horizontal' : 'vertical', spec.name);
    }
    if (!placed) return randomFleet();
  }
  return { board, ships };
}

function clearPlayerFleet() { state.playerBoard = createEmptyBoard(); state.playerShips = []; state.selectedShip = 0; renderSetup(); }
function startPreparation() { clearPlayerFleet(); showScreen('setup'); renderSetup(); }

function renderFleetList() {
  $('#fleet-list').innerHTML = FLEET.map((ship, index) => {
    const placed = index < state.playerShips.length;
    return `<button class="fleet-item ${placed ? 'is-placed' : ''} ${index === state.selectedShip ? 'is-selected' : ''}" type="button" data-fleet-index="${index}" ${placed ? 'disabled' : ''}><span class="fleet-status">${placed ? '✓' : String(index + 1).padStart(2, '0')}</span><span><strong>${ship.name}</strong><small>${ship.symbol}</small></span><em>${ship.length} палубы</em></button>`;
  }).join('');
  $$('.fleet-item:not(:disabled)').forEach((item) => item.addEventListener('click', () => { state.selectedShip = Number(item.dataset.fleetIndex); renderSetup(); }));
}

function renderSetup() {
  renderBoard($('#setup-board'), state.playerBoard, 'setup'); renderFleetList();
  const placed = state.playerShips.length;
  $('#setup-counter').textContent = `${placed} / ${FLEET.length} кораблей`;
  $('#start-battle').disabled = placed !== FLEET.length;
  $('#rotation-label').textContent = state.rotation === 'horizontal' ? 'ГОРИЗОНТАЛЬНО' : 'ВЕРТИКАЛЬНО';
  const nextShip = FLEET[state.selectedShip] || FLEET[FLEET.length - 1];
  $('#setup-help').textContent = placed === FLEET.length ? 'Флот готов. Можно начинать бой.' : `Нажми на поле, чтобы поставить корабль «${nextShip.name}» (${nextShip.length} клет${nextShip.length === 1 ? 'ка' : 'ки'}).`;
}

function renderBoard(element, board, mode) {
  if (!element) return;
  element.innerHTML = '';
  board.forEach((shipId, position) => {
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'cell';
    const { row, col } = coordsOf(position); cell.setAttribute('aria-label', `Клетка ${String.fromCharCode(65 + col)}${row + 1}`);
    if (mode === 'setup' && shipId !== null) cell.classList.add('ship');
    if (mode === 'player' && shipId !== null) { cell.classList.add('ship'); if (state.playerShips[shipId]?.hits.has(position)) cell.classList.add('hit'); }
    if (mode === 'enemy' && state.playerShots.has(position)) { const enemyShip = shipId === null ? null : state.enemyShips[shipId]; cell.classList.add(enemyShip ? 'hit' : 'miss'); if (enemyShip?.hits.size === enemyShip.length) cell.classList.add('sunk'); }
    if (mode === 'player' && state.aiShots.has(position)) cell.classList.add(shipId === null ? 'miss' : 'hit');
    if (mode === 'enemy') cell.addEventListener('click', () => fireAt(position));
    if (mode === 'setup') cell.addEventListener('click', () => tryPlaceSelected(position));
    element.appendChild(cell);
  });
}

function tryPlaceSelected(position) {
  if (state.selectedShip >= FLEET.length) return;
  const { row, col } = coordsOf(position), spec = FLEET[state.selectedShip];
  if (!placeShip(state.playerBoard, state.playerShips, row, col, spec.length, state.rotation, spec.name)) return notify('Так поставить корабль нельзя: проверь границы и расстояние между кораблями.');
  state.selectedShip = FLEET.findIndex((_, index) => index >= state.playerShips.length); if (state.selectedShip === -1) state.selectedShip = FLEET.length; renderSetup();
}
function randomizePlayer() { const generated = randomFleet(); state.playerBoard = generated.board; state.playerShips = generated.ships; state.selectedShip = FLEET.length; renderSetup(); notify('Флот расставлен автоматически.'); }

function beginBattle() {
  if (state.playerShips.length !== FLEET.length) return notify('Сначала расставь все корабли.');
  const generated = randomFleet(); state.enemyBoard = generated.board; state.enemyShips = generated.ships; state.playerShots = new Set(); state.aiShots = new Set(); state.aiTargets = []; state.turn = 'player'; state.shots = 0; state.hits = 0;
  $('#battle-status').textContent = 'Выбери клетку на поле противника.'; updateTurnUI(); renderBattle(); showScreen('battle');
}
function renderBattle() { renderBoard($('#player-board'), state.playerBoard, 'player'); renderBoard($('#enemy-board'), state.enemyBoard, 'enemy'); }
function updateTurnUI() { const isPlayer = state.turn === 'player'; $('#turn-indicator').innerHTML = `<span class="status-dot"></span>${isPlayer ? 'ТВОЙ ХОД' : 'ХОД ИИ'}`; $('#battle-eyebrow').textContent = isPlayer ? '// МИССИЯ В ПРОЦЕССЕ · ТВОЙ ХОД' : '// МИССИЯ В ПРОЦЕССЕ · ИИ ПРИЦЕЛИВАЕТСЯ'; }
function shipAt(board, position, ships) { return board[position] === null ? null : ships[board[position]]; }
function isFleetDestroyed(ships) { return ships.every((ship) => ship.hits.size === ship.length); }

function fireAt(position) {
  if (state.screen !== 'battle' || state.turn !== 'player' || state.playerShots.has(position)) return;
  state.playerShots.add(position); state.shots += 1;
  const ship = shipAt(state.enemyBoard, position, state.enemyShips);
  if (ship) {
    ship.hits.add(position); state.hits += 1; const sunk = ship.hits.size === ship.length;
    $('#battle-status').textContent = sunk ? `Потоплен корабль «${ship.name}»! Стреляй дальше.` : 'Попадание! Твой ход продолжается.';
    renderBattle(); if (isFleetDestroyed(state.enemyShips)) return finishGame(true); updateTurnUI(); return;
  }
  $('#battle-status').textContent = 'Промах. Компьютер готовит ответный выстрел.'; state.turn = 'ai'; updateTurnUI(); renderBattle(); window.setTimeout(aiTurn, 650);
}

function chooseAiTarget() {
  const available = [...Array(SIZE * SIZE).keys()].filter((position) => !state.aiShots.has(position));
  if (state.difficulty === 'smart' && state.aiTargets.length) while (state.aiTargets.length) { const target = state.aiTargets.shift(); if (!state.aiShots.has(target)) return target; }
  return available[Math.floor(Math.random() * available.length)];
}
function aiTurn() {
  if (state.screen !== 'battle') return;
  const position = chooseAiTarget(); state.aiShots.add(position); const ship = shipAt(state.playerBoard, position, state.playerShips);
  if (ship) {
    ship.hits.add(position); const { row, col } = coordsOf(position);
    if (state.difficulty === 'smart' && ship.hits.size < ship.length) neighbors(row, col, false).forEach((near) => { if (!state.aiShots.has(near)) state.aiTargets.push(near); });
    $('#battle-status').textContent = ship.hits.size === ship.length ? `ИИ потопил твой «${ship.name}». Он стреляет ещё.` : 'ИИ попал. Он стреляет ещё.'; renderBattle(); if (isFleetDestroyed(state.playerShips)) return finishGame(false); window.setTimeout(aiTurn, 650); return;
  }
  $('#battle-status').textContent = 'ИИ промахнулся. Твой ход.'; state.turn = 'player'; updateTurnUI(); renderBattle();
}

async function finishGame(won) {
  if (state.user && won) {
    try { const result = await apiRequest('/api/progress/complete', { method: 'POST', body: JSON.stringify({ level: state.selectedLevel, shots: state.shots, hits: state.hits }) }); state.user = result.user; state.progress = { levels: result.levels }; updateBalances(); } catch { notify('Победа сохранена локально. Серверная синхронизация будет повторена позже.'); }
  }
  state.screen = 'result';
  if (won) { state.wins += 1; state.coins += 200; $('#result-title').innerHTML = 'ПОБЕДА<span>!</span>'; $('#result-eyebrow').textContent = '// МИССИЯ ЗАВЕРШЕНА · ФЛОТ ПРОТИВНИКА УНИЧТОЖЕН'; $('#result-reward').textContent = '+200 ◉'; $('#result-message').textContent = `Точность залпа: ${Math.round((state.hits / Math.max(1, state.shots)) * 100)}%. Отличная работа, капитан.`; }
  else { state.losses += 1; state.coins += 25; $('#result-title').innerHTML = 'ПОРАЖЕНИЕ<span>!</span>'; $('#result-eyebrow').textContent = '// СВЯЗЬ С ФЛОТОМ ПОТЕРЯНА'; $('#result-reward').textContent = '+25 ◉'; $('#result-message').textContent = 'Последний корабль уничтожен. Перегруппируйся и попробуй снова.'; }
  localStorage.setItem('neonFleetWins', state.wins); localStorage.setItem('neonFleetLosses', state.losses); localStorage.setItem('neonFleetCoins', state.coins); updateBalances(); showScreen('result');
}

function levelUnlocked(level) {
  if (level === 1) return true;
  if (!state.user || !state.progress) return false;
  return Boolean(state.progress.levels?.find((item) => item.level === level)?.unlocked);
}
function renderLevels() {
  $$('[data-level]').forEach((button) => { const level = Number(button.dataset.level); const unlocked = levelUnlocked(level); button.disabled = !unlocked; button.textContent = unlocked ? 'ВЫБРАТЬ →' : 'ЗАКРЫТО'; });
  const next = state.user?.nextUnlockAt ? new Date(state.user.nextUnlockAt).toLocaleString('ru-RU') : '';
  $('#level-note').textContent = state.user?.subscriptionUntil ? 'PRO активна: уровни открыты сразу.' : next ? `Следующий уровень откроется ${next}. PRO-подписка снимает ожидание.` : 'Следующий уровень после победы откроется через 24 часа. PRO-подписка снимает ожидание.';
}

function renderStats() {
  if (!state.user) return;
  $('#wins-stat').textContent = state.user.wins; $('#losses-stat').textContent = state.user.losses; $('#accuracy-stat').textContent = `${state.user.totalShots ? Math.round((state.user.totalHits / state.user.totalShots) * 100) : 0}%`;
  $('#xp-progress').style.width = `${Math.min(100, state.user.wins * 10)}%`; $('#xp-label').textContent = `${state.user.wins} побед · ${Math.min(1000, state.user.wins * 100)} / 1000 XP`;
}
function updateBalances() { const coins = state.user?.coins ?? state.coins; const formatted = Number(coins).toLocaleString('ru-RU'); $('#coin-balance').textContent = formatted; $('#shop-balance').textContent = formatted; }

function renderAccount() {
  const loggedIn = Boolean(state.user); $('#auth-logged-out').hidden = loggedIn; $('#auth-logged-in').hidden = !loggedIn;
  if (!loggedIn) { $('#profile-id').textContent = 'GUEST MODE'; return; }
  $('#profile-id').textContent = `@${state.user.username}`; $('#profile-name').textContent = state.user.displayName; $('#profile-username').textContent = `@${state.user.username}`; $('#profile-avatar').textContent = state.user.displayName.slice(0, 2).toUpperCase();
  const subscribed = state.user.subscriptionUntil && new Date(state.user.subscriptionUntil).getTime() > Date.now(); $('#subscription-status').textContent = subscribed ? `PRO активна до ${new Date(state.user.subscriptionUntil).toLocaleDateString('ru-RU')}. Все уровни доступны сразу.` : 'Открывай следующие уровни сразу после победы.';
  renderStats(); renderLevels(); loadFriends(); updateBalances();
}

async function loadSession() {
  try { const result = await apiRequest('/api/me'); state.user = result.user; if (state.user) { const progress = await apiRequest('/api/progress'); state.user = progress.user; state.progress = progress; } } catch { state.user = null; }
  renderAccount(); renderLevels(); updateBalances();
}
async function login() { window.location.href = '/auth/login'; }
async function logout() { await apiRequest('/auth/logout', { method: 'POST' }).catch(() => {}); state.user = null; state.progress = null; renderAccount(); renderLevels(); notify('Ты вышел из аккаунта.'); }
async function subscribeDemo() { if (!state.user) return notify('Сначала войди через Manus.'); try { const result = await apiRequest('/api/subscription/demo', { method: 'POST', body: '{}' }); state.user = result.user; state.progress = result; renderAccount(); notify('Demo PRO активирована на 30 дней.'); } catch { notify('Не удалось активировать подписку.'); } }

async function loadFriends() {
  if (!state.user) return;
  try { const result = await apiRequest('/api/friends'); $('#friends-list').innerHTML = result.friends.length ? result.friends.map((item) => `<div class="friend-row"><span><strong>${item.user.displayName}</strong><small>@${item.user.username} · ${item.status}</small></span>${item.status === 'pending' && item.direction === 'incoming' ? `<button class="button button-small" type="button" data-friend-respond="${item.id}">ПРИНЯТЬ</button>` : ''}</div>`).join('') : '<p class="muted-copy">Пока нет друзей. Найди капитана по нику.</p>'; } catch { $('#friends-list').innerHTML = '<p class="muted-copy">Не удалось загрузить список друзей.</p>'; }
}
async function searchFriends() {
  if (!state.user) return notify('Сначала войди через Manus.');
  const q = $('#friend-search').value.trim(); if (q.length < 2) return notify('Введи хотя бы 2 символа.');
  try { const result = await apiRequest(`/api/users/search?q=${encodeURIComponent(q)}`); $('#friend-results').innerHTML = result.users.length ? result.users.map((item) => `<div class="friend-row"><span><strong>${item.displayName}</strong><small>@${item.username}</small></span><button class="button button-small" type="button" data-friend-add="${item.username}">ДОБАВИТЬ</button></div>`).join('') : '<p class="muted-copy">Капитан не найден.</p>'; } catch { notify('Поиск временно недоступен.'); }
}
async function addFriend(username) { try { await apiRequest('/api/friends/request', { method: 'POST', body: JSON.stringify({ username }) }); notify('Заявка отправлена.'); loadFriends(); } catch (error) { notify(error.message === 'friend_request_exists' ? 'Заявка уже существует.' : 'Не удалось отправить заявку.'); } }
async function respondFriend(id) { await apiRequest('/api/friends/respond', { method: 'POST', body: JSON.stringify({ friendshipId: id, accept: true }) }).catch(() => {}); loadFriends(); }

async function buyItem(button) {
  if (!state.user) return notify('Войди в аккаунт, чтобы покупки сохранялись в кошельке.');
  try { const result = await apiRequest('/api/shop/purchase', { method: 'POST', body: JSON.stringify({ itemKey: button.dataset.item }) }); state.user = result.user; button.classList.add('is-bought'); button.textContent = 'ЭКИПИРОВАНО ✓'; updateBalances(); notify('Предмет добавлен в коллекцию.'); } catch (error) { notify(error.message === 'insufficient_coins' ? 'Недостаточно монет.' : 'Покупка не выполнена.'); }
}

async function createMatch() {
  if (!state.user) return notify('Для PVP нужен аккаунт. Войди через Manus.');
  try { const result = await apiRequest('/api/matches', { method: 'POST', body: '{}' }); state.onlineMatch = result.match; showScreen('online'); renderOnlineMatch(); startOnlinePolling(); notify('Комната создана. Отправь код другу.'); } catch { notify('Не удалось создать комнату.'); }
}
async function joinMatch() {
  if (!state.user) return notify('Для PVP нужен аккаунт. Войди через Manus.');
  const code = $('#join-code').value.trim().toUpperCase(); if (!code) return notify('Введи код комнаты.');
  try { const result = await apiRequest('/api/matches/join', { method: 'POST', body: JSON.stringify({ code }) }); state.onlineMatch = result.match; showScreen('online'); renderOnlineMatch(); startOnlinePolling(); notify('Ты подключился к комнате.'); } catch { notify('Комната не найдена или уже занята.'); }
}
function startOnlinePolling() { clearInterval(state.onlinePoll); state.onlinePoll = setInterval(pollOnlineMatch, 1800); }
async function pollOnlineMatch() { if (!state.onlineMatch?.code) return; try { const result = await apiRequest(`/api/matches/${state.onlineMatch.code}`); state.onlineMatch = result.match; renderOnlineMatch(); } catch { clearInterval(state.onlinePoll); } }
function localFleetForOnline() { const generated = randomFleet(); state.onlineFleet = generated.ships.map((ship) => ({ length: ship.length, positions: ship.positions })); return state.onlineFleet; }
async function prepareOnlineFleet() {
  if (!state.onlineMatch) return notify('Сначала создай комнату или подключись по коду.');
  if (!state.onlineFleet) localFleetForOnline();
  try { const result = await apiRequest(`/api/matches/${state.onlineMatch.code}/fleet`, { method: 'PUT', body: JSON.stringify({ fleet: state.onlineFleet }) }); state.onlineMatch = result.match; renderOnlineMatch(); notify('Флот отправлен на сервер.'); } catch { notify('Сервер отклонил расстановку.'); }
}
function fleetPositions(fleet) { return new Set((fleet || []).flatMap((ship) => ship.positions || [])); }
function renderOnlineBoard(element, mode) {
  if (!element || !state.onlineMatch) return;
  const ownPositions = fleetPositions(state.onlineMatch.myFleet); const ownShots = new Set(state.onlineMatch.myShots || []); const shotsOnMe = new Set(state.onlineMatch.shotsOnMe || []); const opponent = fleetPositions(state.onlineMatch.opponentFleet || []);
  element.innerHTML = '';
  for (let position = 0; position < 100; position += 1) {
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'cell';
    if (mode === 'player') { if (ownPositions.has(position)) cell.classList.add('ship'); if (shotsOnMe.has(position)) cell.classList.add(ownPositions.has(position) ? 'hit' : 'miss'); }
    else { if (ownShots.has(position)) cell.classList.add(opponent.has(position) ? 'hit' : 'miss'); if (state.onlineMatch.status === 'finished' && opponent.has(position)) cell.classList.add('ship'); if (state.onlineMatch.status === 'active') cell.addEventListener('click', () => onlineFire(position)); }
    element.appendChild(cell);
  }
}
function renderOnlineMatch() {
  if (!state.onlineMatch) { $('#online-status').textContent = 'Создай комнату или подключись по коду.'; $('#online-code').textContent = '— — — — — — — —'; return; }
  $('#online-code').textContent = state.onlineMatch.code; $('#online-code-help').textContent = state.onlineMatch.status === 'waiting' ? 'Ждём второго капитана. Отправь ему этот код.' : 'Комната синхронизируется через сервер.';
  const readyText = state.onlineMatch.status === 'waiting' ? `${state.onlineMatch.opponentReady ? 'Оба флота готовы' : 'Ждём друга и его флот'}` : state.onlineMatch.status === 'active' ? (Number(state.onlineMatch.turnUserId) === Number(state.onlineMatch.hostId) ? 'ХОД КАПИТАНА HOST' : 'ХОД КАПИТАНА GUEST') : 'МАТЧ ЗАВЕРШЁН';
  $('#online-status').textContent = readyText; $('#online-help').textContent = state.onlineMatch.myFleetReady ? 'Твой флот готов. Клетки противника активны, когда наступит твой ход.' : 'Нажми «Готовить флот», чтобы отправить расстановку другу.';
  renderOnlineBoard($('#online-player-board'), 'player'); renderOnlineBoard($('#online-enemy-board'), 'enemy');
}
async function onlineFire(position) {
  if (!state.onlineMatch || state.onlineMatch.status !== 'active') return;
  try { const result = await apiRequest(`/api/matches/${state.onlineMatch.code}/shot`, { method: 'POST', body: JSON.stringify({ position }) }); state.onlineMatch = result.match; renderOnlineMatch(); if (result.sunkAll) notify('Победа в PVP!'); } catch (error) { notify(error.message === 'not_your_turn' ? 'Сейчас ход друга.' : 'Этот выстрел недоступен.'); }
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const screenTarget = event.target.closest('[data-screen]'); if (screenTarget) { event.preventDefault(); showScreen(screenTarget.dataset.screen); }
    const actionTarget = event.target.closest('[data-action]'); if (actionTarget) {
      const action = actionTarget.dataset.action;
      if (action === 'new-game') startPreparation(); if (action === 'login') login(); if (action === 'logout') logout(); if (action === 'subscribe-demo') subscribeDemo();
      if (action === 'rotate') { state.rotation = state.rotation === 'horizontal' ? 'vertical' : 'horizontal'; renderSetup(); }
      if (action === 'randomize') randomizePlayer(); if (action === 'clear-fleet') clearPlayerFleet(); if (action === 'start-battle') beginBattle();
      if (action === 'add-coins') notify('Монеты начисляются за победы в бою.'); if (action === 'settings') notify('Автосохранение включено.');
      if (action === 'search-friends') searchFriends(); if (action === 'create-match') createMatch(); if (action === 'join-match') joinMatch(); if (action === 'online-ready') prepareOnlineFleet();
    }
    const add = event.target.closest('[data-friend-add]'); if (add) addFriend(add.dataset.friendAdd);
    const respond = event.target.closest('[data-friend-respond]'); if (respond) respondFriend(respond.dataset.friendRespond);
  });
  $$('[data-difficulty]').forEach((button) => button.addEventListener('click', () => { const level = Number(button.dataset.level || 1); if (!levelUnlocked(level)) return notify('Уровень ещё закрыт. Победи на предыдущем или активируй PRO.'); state.selectedLevel = level; state.difficulty = button.dataset.difficulty; notify(state.difficulty === 'smart' ? 'Режим «Охота» выбран.' : 'Режим «Разведка» выбран.'); startPreparation(); }));
  $$('.shop-buy').forEach((button) => button.addEventListener('click', () => buyItem(button)));
}

async function init() {
  bindEvents(); updateBalances(); renderSetup(); renderLevels();
  const requestedScreen = window.location.hash.replace('#', ''); if (['home', 'levels', 'setup', 'battle', 'online', 'result', 'shop', 'account'].includes(requestedScreen)) showScreen(requestedScreen);
  await loadSession();
}

init();
