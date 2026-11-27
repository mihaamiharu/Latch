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
    card.append(stop);
  } else {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = task.state === 'connecting'
      ? 'Connection in progress. Refresh to check its state.'
      : 'Inspect this task with Latch reconciliation.';
    card.append(hint);
  }
  return card;
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
      truncated: data.truncated,
    }, null, 2);
  } catch (e) {
    $('connection').textContent = 'Unable to read connection status';
    $('empty').textContent = e.message;
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').onclick = () => void refresh();
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
