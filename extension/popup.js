const $ = id => document.getElementById(id);

const ui = async (op, payload) => {
  const response = await chrome.runtime.sendMessage({type: 'ui', op, payload});
  if (!response?.ok) {
    throw Object.assign(
      new Error(response?.error?.message || 'Local host controls are unavailable.'),
      {code: response?.error?.code || 'UI_UNSUPPORTED'},
    );
  }
  return response.result;
};

let busy = false;
let currentTabInGroup = false;

async function refreshGroupButton() {
  const btn = $('toggle-group');
  if (!btn) return;
  try {
    const res = await chrome.runtime.sendMessage({type: 'latch-group', action: 'status'});
    if (!res?.ok || !res.result?.supported) {
      btn.hidden = true;
      currentTabInGroup = false;
      return;
    }
    currentTabInGroup = !!res.result.inGroup;
    btn.dataset.inGroup = String(currentTabInGroup);
    btn.textContent = currentTabInGroup ? 'Remove from Latch' : 'Add tab to Latch';
    btn.disabled = busy;
    btn.hidden = false;
  } catch {
    btn.hidden = true;
  }
}

function taskView(task) {
  const card = document.createElement('article');
  card.className = 'task';
  card.dataset.key = task.key;

  const title = document.createElement('h3');
  title.textContent = task.session;
  card.append(title);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    task.workspace,
    task.transport,
    task.state,
    `${task.tabCount || 0} ${(task.tabCount || 0) === 1 ? 'tab' : 'tabs'}`,
  ].filter(Boolean).join(' · ');
  card.append(meta);

  const list = document.createElement('ul');
  for (const tab of task.tabs || []) {
    const li = document.createElement('li');
    li.textContent = tab.title || 'Untitled tab';
    const origin = document.createElement('small');
    origin.textContent = tab.origin;
    li.append(origin);
    list.append(li);
  }
  card.append(list);

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  if (task.runId) {
    const view = document.createElement('button');
    view.disabled = busy;
    view.type = 'button';
    view.textContent = 'View run';
    view.setAttribute('aria-label', `View exploration run for ${task.session}`);
    view.onclick = async () => {
      if (busy) return;
      busy = true;
      view.disabled = true;
      try {
        const res = await ui('open-library', {runId: task.runId});
        await chrome.tabs.create({url: res.url});
      } catch (e) {
        $('notice').textContent = `${e.message} (${e.code})`;
      } finally {
        busy = false;
        view.disabled = false;
      }
    };
    actions.append(view);
  }

  if (task.revocable) {
    const stop = document.createElement('button');
    stop.disabled = busy;
    stop.type = 'button';
    stop.className = 'stop';
    stop.textContent = 'Stop session';
    stop.setAttribute('aria-label', `Stop session ${task.session}`);
    stop.onclick = async () => {
      if (busy) return;
      busy = true;
      stop.disabled = true;
      $('notice').textContent = 'Stopping automation…';
      try {
        const result = await ui('revoke', {
          key: task.key,
          leaseId: task.leaseId,
          revision: task.revision,
          hostGeneration: task.hostGeneration,
        });
        $('notice').textContent = result.cleanup === 'confirmed'
          ? 'Session stopped. Your tabs are still open.'
          : 'Access stopped. CLI cleanup is unconfirmed; inspect this task with Latch.';
        if (result.outcome === 'unknown') {
          $('notice').textContent += ' An interrupted action may have completed; check before repeating it.';
        }
      } catch (e) {
        $('notice').textContent = e.code === 'SESSION_BUSY'
          ? 'This task is busy. No access was stopped; refresh and try again.'
          : `${e.message} (${e.code})`;
      } finally {
        busy = false;
        await refresh();
      }
    };
    actions.append(stop);
  } else {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = task.state === 'connecting'
      ? 'Connection in progress. Refresh to check its state.'
      : 'Inspect this task with Latch reconciliation.';
    actions.append(hint);
  }
  card.append(actions);
  return card;
}

function renderLibrary(library) {
  const openBtn = $('open-library');
  const storageSection = $('storage-section');
  if (!library) {
    openBtn.hidden = true;
    storageSection.hidden = true;
    return;
  }
  const count = Number.isFinite(library.runCount) ? library.runCount : 0;
  openBtn.textContent = count > 0 ? `Open Library (${count})` : 'Open Library';
  openBtn.hidden = false;
  storageSection.hidden = false;

  const input = $('artifacts-dir');
  const chooseBtn = $('choose-folder');
  const saveBtn = $('save-artifacts');
  const resetBtn = $('reset-artifacts');
  const meta = $('storage-meta');
  input.value = library.path || '';
  if (library.envOverride) {
    meta.textContent = 'Overridden by LATCH_ARTIFACT_ROOT environment variable.';
  } else if (library.source === 'config') {
    meta.textContent = `Custom folder saved in config.json (default: ${library.defaultPath}).`;
  } else {
    meta.textContent = `Using default folder (${count} saved ${count === 1 ? 'run' : 'runs'}).`;
  }
  input.disabled = !!library.envOverride || busy;
  chooseBtn.disabled = !!library.envOverride || busy;
  saveBtn.disabled = !!library.envOverride || busy;
  resetBtn.disabled = !!library.envOverride || library.source === 'default' || busy;
}

async function refresh() {
  $('refresh').disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({type: 'status'});
    $('badge').textContent = status.connected ? 'Connected' : status.state === 'degraded' ? 'Needs attention' : 'Offline';
    $('badge').dataset.ready = String(!!status.connected);
    $('connection').textContent = status.connected
      ? 'Local bridge connected'
      : status.state === 'connecting'
        ? 'Connecting to local bridge…'
        : 'Local bridge disconnected';
    $('retry').hidden = !!status.connected;
    $('sessions').replaceChildren();
    $('count').textContent = '0';
    $('profile').textContent = 'This Chrome profile';
    $('empty').hidden = false;
    renderLibrary(null);
    await refreshGroupButton();

    if (!status.connected) {
      $('empty').textContent = 'Sessions are unavailable while the bridge is offline.';
      $('profile').textContent = status.nextAttemptAt
        ? 'Retry scheduled. Automation will stay disconnected.'
        : 'Use Retry after checking local setup.';
      $('status').textContent = JSON.stringify(status, null, 2);
      return;
    }

    let data;
    try {
      data = await ui('status');
    } catch (e) {
      $('empty').textContent = e.code === 'UI_UNSUPPORTED'
        ? 'Update the matching local host to use session controls.'
        : `Unable to read sessions: ${e.message} (${e.code})`;
      $('status').textContent = JSON.stringify({...status, error: e.code}, null, 2);
      return;
    }

    $('profile').textContent = data.profile.paired
      ? `Paired profile: ${data.profile.aliases.join(', ')}`
      : 'This profile is not paired. See connection details to pair it.';
    if (!data.nativeAvailable) $('connection').textContent = 'Bridge connected · native access unavailable';
    renderLibrary(data.library || null);
    $('count').textContent = String(data.sessions.length);
    $('empty').hidden = !!data.sessions.length;
    $('empty').textContent = 'No active agent sessions. Connect from your task terminal.';
    for (const task of data.sessions) $('sessions').append(taskView(task));
    $('status').textContent = JSON.stringify({
      ...status,
      release: data.release,
      extensionVersion: data.extensionVersion,
      nativeAvailable: data.nativeAvailable,
      uiControl: data.uiControl,
      library: data.library || null,
      truncated: data.truncated,
    }, null, 2);
  } catch (e) {
    $('connection').textContent = 'Unable to read connection status';
    $('empty').textContent = e.message;
  } finally {
    $('refresh').disabled = false;
  }
}

$('toggle-group').onclick = async () => {
  if (busy) return;
  busy = true;
  $('toggle-group').disabled = true;
  try {
    const action = currentTabInGroup ? 'remove' : 'add';
    const res = await chrome.runtime.sendMessage({type: 'latch-group', action});
    if (!res?.ok) throw new Error(res?.error?.message || 'Unable to update Latch tab group.');
    $('notice').textContent = res.result.inGroup
      ? 'Tab added to Latch group. Run `latch connect` from your terminal.'
      : 'Tab removed from Latch group. Any attached session was detached; your tab stays open.';
  } catch (e) {
    $('notice').textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
};
$('refresh').onclick = () => void refresh();
$('open-library').onclick = async () => {
  if (busy) return;
  busy = true;
  $('open-library').disabled = true;
  try {
    const res = await ui('open-library');
    await chrome.tabs.create({url: res.url});
  } catch (e) {
    $('notice').textContent = `${e.message} (${e.code})`;
  } finally {
    busy = false;
    $('open-library').disabled = false;
  }
};
$('choose-folder').onclick = async () => {
  if (busy) return;
  busy = true;
  $('choose-folder').disabled = true;
  $('notice').textContent = 'Select a folder in the dialog…';
  try {
    const res = await ui('choose-folder');
    $('notice').textContent = res.cancelled
      ? 'Folder selection cancelled.'
      : `Artifacts folder saved: ${res.path}`;
  } catch (e) {
    $('notice').textContent = `${e.message} (${e.code})`;
  } finally {
    busy = false;
    await refresh();
  }
};
$('save-artifacts').onclick = async () => {
  if (busy) return;
  busy = true;
  $('save-artifacts').disabled = true;
  try {
    const value = $('artifacts-dir').value.trim();
    const res = await ui('set-config', {key: 'artifactsDir', value});
    $('notice').textContent = `Artifacts folder saved: ${res.path}`;
  } catch (e) {
    $('notice').textContent = `${e.message} (${e.code})`;
  } finally {
    busy = false;
    await refresh();
  }
};
$('reset-artifacts').onclick = async () => {
  if (busy) return;
  busy = true;
  $('reset-artifacts').disabled = true;
  try {
    const res = await ui('set-config', {key: 'artifactsDir', reset: true});
    $('notice').textContent = `Artifacts folder reset to default: ${res.path}`;
  } catch (e) {
    $('notice').textContent = `${e.message} (${e.code})`;
  } finally {
    busy = false;
    await refresh();
  }
};
$('retry').onclick = async () => {
  if (busy) return;
  busy = true;
  try {
    await chrome.runtime.sendMessage({type: 'retry'});
    $('notice').textContent = 'Retry started. Existing automation will not reconnect.';
  } finally {
    busy = false;
    await refresh();
  }
};
void refresh();
