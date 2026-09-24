(() => {
  const draggableSelector = '.todo-item,.board-card,.calendar-task,.space-task,.space-card h3';
  let gesture = null;
  let suppressClickUntil = 0;

  const touchById = (list, id) => Array.from(list).find(touch => touch.identifier === id);
  const clearTarget = () => document.querySelectorAll('.mobile-drop-target')
    .forEach(element => element.classList.remove('mobile-drop-target'));

  function targetAt(x, y, source) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (source.matches('.todo-item')) return hit.closest('.todo-item');
    if (source.matches('.board-card')) return hit.closest('.board-column');
    if (source.matches('.calendar-task')) return hit.closest('.calendar-day');
    if (source.matches('.space-task')) return hit.closest('.space-card');
    return null;
  }

  function startDrag(current) {
    if (gesture !== current || current.active) return;
    clearTimeout(current.timer);
    current.active = true;
    current.visualSource.classList.add('mobile-dragging');
    document.body.classList.add('mobile-drag-active');
    if (current.kind !== 'space-card') {
      current.ghost = document.createElement('div');
      current.ghost.className = 'mobile-drag-ghost';
      current.ghost.textContent = current.source.querySelector('.todo-title')?.textContent
        || current.source.firstChild?.textContent
        || current.source.textContent;
      document.body.append(current.ghost);
      moveGhost(current, current.lastX, current.lastY);
    }
    navigator.vibrate?.(15);
  }

  function moveGhost(current, x, y) {
    if (!current.ghost) return;
    current.ghost.style.left = `${x}px`;
    current.ghost.style.top = `${y}px`;
  }

  function autoScroll(current, x, y) {
    const host = current.source.matches('.todo-item')
      ? document.querySelector('.todo-list')
      : current.source.closest('.mode-view');
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const margin = Math.min(64, rect.height / 4);
    const vertical = y < rect.top + margin ? -18 : y > rect.bottom - margin ? 18 : 0;
    const horizontal = x < rect.left + margin ? -18 : x > rect.right - margin ? 18 : 0;
    if (vertical || horizontal) host.scrollBy(horizontal, vertical);
  }

  function cleanup(current) {
    clearTimeout(current.timer);
    clearTarget();
    current.visualSource.classList.remove('mobile-dragging');
    current.ghost?.remove();
    document.body.classList.remove('mobile-drag-active');
    if (gesture === current) gesture = null;
  }

  async function applyDrop(current, target) {
    const id = current.source.dataset.id;
    if (!id || !target) return;
    if (current.source.matches('.todo-item')) {
      const targetId = target.dataset.id;
      if (!targetId || targetId === id) return;
      const order = sortedTodos().map(todo => todo.id);
      const from = order.indexOf(id);
      const to = order.indexOf(targetId);
      if (from < 0 || to < 0) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      const note = activeNote();
      note.manualSort = true;
      note.todos = note.todos.map(todo => ({ ...todo, order: order.indexOf(todo.id) }));
    } else if (current.source.matches('.board-card')) {
      const found = locateTodo(id);
      if (!found) return;
      const status = target.dataset.status;
      found.todo.status = status;
      found.todo.done = status === 'done';
      found.todo.completedAt = status === 'done' ? Date.now() : null;
    } else if (current.source.matches('.calendar-task')) {
      const found = locateTodo(id);
      if (!found) return;
      found.todo.due = target.dataset.date;
    } else if (current.source.matches('.space-task')) {
      const found = locateTodo(id);
      const destination = state.notes.find(note => note.id === target.dataset.noteId);
      if (!found || !destination || found.note.id === destination.id) return;
      found.note.todos = found.note.todos.filter(todo => todo.id !== id);
      destination.todos.push(found.todo);
    }
    await save();
    render();
  }

  document.addEventListener('touchstart', event => {
    if (gesture || event.touches.length !== 1) return;
    const source = event.target.closest(draggableSelector);
    if (!source) return;
    if (source.matches('.todo-item') && !event.target.closest('.mobile-drag-handle')) return;
    if (event.target.closest('input,textarea,select,a')
      || (event.target.closest('button') && !source.matches('.calendar-task'))) return;
    const touch = event.changedTouches[0];
    const isSpaceCard = source.matches('.space-card h3');
    const card = isSpaceCard ? source.closest('.space-card') : null;
    const note = card ? state.notes.find(item => item.id === card.dataset.noteId) : null;
    const current = {
      source,
      visualSource: card || source,
      kind: isSpaceCard ? 'space-card' : 'item',
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startLeft: note?.position?.x || 0,
      startTop: note?.position?.y || 0,
      note,
      card,
      active: false,
      ghost: null,
      target: null
    };
    current.timer = setTimeout(() => startDrag(current), 80);
    gesture = current;
  }, { passive: true });

  document.addEventListener('touchmove', event => {
    const current = gesture;
    if (!current) return;
    const touch = touchById(event.touches, current.touchId);
    if (!touch) return;
    current.lastX = touch.clientX;
    current.lastY = touch.clientY;
    if (!current.active && Math.hypot(touch.clientX - current.startX, touch.clientY - current.startY) >= 3) {
      startDrag(current);
    }
    if (!current.active) return;
    event.preventDefault();
    if (current.kind === 'space-card') {
      current.note.position = {
        x: Math.max(0, current.startLeft + touch.clientX - current.startX),
        y: Math.max(0, current.startTop + touch.clientY - current.startY)
      };
      current.card.style.left = `${current.note.position.x}px`;
      current.card.style.top = `${current.note.position.y}px`;
      autoScroll(current, touch.clientX, touch.clientY);
      return;
    }
    moveGhost(current, touch.clientX, touch.clientY);
    autoScroll(current, touch.clientX, touch.clientY);
    const target = targetAt(touch.clientX, touch.clientY, current.source);
    if (target !== current.target) {
      clearTarget();
      current.target = target;
      target?.classList.add('mobile-drop-target');
    }
  }, { passive: false });

  document.addEventListener('touchend', async event => {
    const current = gesture;
    if (!current) return;
    const touch = touchById(event.changedTouches, current.touchId);
    if (!touch) return;
    if (!current.active) {
      cleanup(current);
      return;
    }
    event.preventDefault();
    suppressClickUntil = Date.now() + 400;
    if (current.kind === 'space-card') {
      cleanup(current);
      await save();
      return;
    }
    const target = targetAt(touch.clientX, touch.clientY, current.source);
    cleanup(current);
    await applyDrop(current, target);
  }, { passive: false });

  document.addEventListener('touchcancel', () => gesture && cleanup(gesture));
  document.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const drawer = document.querySelector('#noteDrawer');
  const handle = document.querySelector('#noteDrawerHandle');
  let sheetGesture = null;
  const viewportHeight = () => window.visualViewport?.height || window.innerHeight;

  handle?.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return;
    const touch = event.changedTouches[0];
    sheetGesture = {
      touchId: touch.identifier,
      startY: touch.clientY,
      startHeight: drawer.getBoundingClientRect().height,
      wasExpanded: drawer.classList.contains('expanded'),
      moved: false
    };
    drawer.classList.add('resizing');
  }, { passive: true });

  handle?.addEventListener('touchmove', event => {
    if (!sheetGesture) return;
    const touch = touchById(event.touches, sheetGesture.touchId);
    if (!touch) return;
    event.preventDefault();
    const delta = sheetGesture.startY - touch.clientY;
    if (Math.abs(delta) > 3) {
      sheetGesture.moved = true;
      drawer.classList.remove('expanded');
    }
    const max = viewportHeight();
    drawer.style.height = `${Math.max(max * .34, Math.min(max, sheetGesture.startHeight + delta))}px`;
  }, { passive: false });

  handle?.addEventListener('touchend', event => {
    if (!sheetGesture) return;
    const touch = touchById(event.changedTouches, sheetGesture.touchId);
    if (!touch) return;
    const current = sheetGesture;
    sheetGesture = null;
    drawer.classList.remove('resizing');
    const max = viewportHeight();
    const height = drawer.getBoundingClientRect().height;
    if (!current.moved) {
      setNoteDrawerExpanded(!current.wasExpanded);
    } else if (touch.clientY - current.startY > 90 || height < max * .38) {
      closeNoteDrawer();
    } else if (height > max * .82) {
      setNoteDrawerExpanded(true);
    }
  });

  handle?.addEventListener('touchcancel', () => {
    sheetGesture = null;
    drawer.classList.remove('resizing');
  });
})();
